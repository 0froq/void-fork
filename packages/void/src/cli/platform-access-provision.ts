import { createHash, randomBytes } from 'node:crypto';
import {
  parsePlatformAccessProtection,
  parsePlatformLoginConfiguration,
  type PlatformAccessProtection,
  type PlatformLoginConfiguration,
} from '@void/platform';
import {
  PlatformCloudflareApiError,
  type PlatformCloudflareClient,
} from './platform-cloudflare.ts';

type ObjectValue = Record<string, unknown>;
type AccessResource = {
  name: string;
  fingerprint: string;
  id?: string;
  clientId?: string;
  clientSecret?: string;
  pending: boolean;
  adopted?: boolean;
};
export type PlatformAccessCheckpoint = {
  version: 1;
  accountId: string;
  installationId: string;
  nonce: string;
  resources: Record<string, AccessResource>;
};
export type PlatformAccessProvisionInput = {
  accountId: string;
  installationId: string;
  apiUrl: string;
  proxyUrl: string;
  identityProviderIds: ReadonlyArray<string>;
  policyIds: ReadonlyArray<string>;
  login?: {
    id: string;
    label: string;
    applicationId?: string;
    clientSecret?: string;
    requiredGroups?: ReadonlyArray<string>;
  };
  protection?: { applicationId?: string };
  serviceToken?: { id: string; clientId: string; clientSecret: string };
};
export type PlatformAccessProvisionResult = {
  login?: { configuration: PlatformLoginConfiguration; clientSecret: string };
  protection?: PlatformAccessProtection;
  credentials?: Record<string, { CF_ACCESS_CLIENT_ID: string; CF_ACCESS_CLIENT_SECRET: string }>;
  resources: ReadonlyArray<{ key: string; id: string; name: string; adopted: boolean }>;
};

function object(value: unknown, name: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`platform: Invalid ${name} response from Cloudflare Access.`);
  }
  return value as ObjectValue;
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 8192) {
    throw new Error(`platform: Cloudflare Access did not return ${name}.`);
  }
  return value;
}
function ids(value: unknown): Array<string> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) =>
    typeof entry === 'string' ? entry : text(object(entry, 'policy').id, 'policy ID'),
  );
}
function sameSet(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((id, index) => id === [...right].sort()[index])
  );
}
function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class PlatformAccessClient {
  constructor(
    private readonly client: Pick<PlatformCloudflareClient, 'request'>,
    readonly accountId: string,
  ) {}
  path(suffix: string): string {
    return `/accounts/${encodeURIComponent(this.accountId)}/access/${suffix}`;
  }
  get(suffix: string): Promise<unknown> {
    return this.client.request(this.path(suffix));
  }
  create(suffix: string, body: ObjectValue): Promise<unknown> {
    return this.client.request(this.path(suffix), { method: 'POST', body: JSON.stringify(body) });
  }
  async list(suffix: string): Promise<Array<ObjectValue>> {
    const result: Array<ObjectValue> = [];
    for (let page = 1; page <= 100; page++) {
      const value = await this.get(`${suffix}?page=${page}&per_page=100`);
      if (!Array.isArray(value)) {
        throw new Error('platform: Invalid Access inventory response.');
      }
      result.push(...value.map((entry) => object(entry, 'inventory')));
      if (value.length < 100) {
        return result;
      }
    }
    throw new Error('platform: Access inventory exceeded the supported pagination limit.');
  }
}

function identityRule(rule: ObjectValue): boolean {
  if (rule.email_domain) {
    const domain = object(rule.email_domain, 'email domain').domain;
    return typeof domain === 'string' && /^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i.test(domain);
  }
  if (rule.email) {
    const email = object(rule.email, 'email rule').email;
    return typeof email === 'string' && /^[^\s*@]+@[^\s*@]+\.[^\s*@]+$/.test(email);
  }
  return [
    'email',
    'email_domain',
    'email_list',
    'gsuite',
    'github-organization',
    'saml',
    'okta',
    'group',
  ].some(
    (key) =>
      Object.hasOwn(rule, key) &&
      !!rule[key] &&
      typeof rule[key] === 'object' &&
      !Array.isArray(rule[key]) &&
      Object.keys(rule[key] as object).length > 0,
  );
}

/** Preserve corporate MFA/device requirements; reject broad policies rather than rewriting them. */
export async function verifyCompanyAccessPolicies(
  client: PlatformAccessClient,
  policies: ReadonlyArray<ObjectValue>,
): Promise<void> {
  const groups = new Set<string>();
  const checkedGroups = new Set<string>();
  const checkRules = async (value: unknown, depth = 0): Promise<void> => {
    if (value === undefined) {
      return;
    }
    if (!Array.isArray(value) || value.length > 100 || depth > 8) {
      throw new Error('platform: Unsupported Access policy rule structure.');
    }
    for (const entry of value) {
      const rule = object(entry, 'policy rule');
      if (Object.hasOwn(rule, 'everyone') || Object.hasOwn(rule, 'any_valid_service_token')) {
        throw new Error(
          'platform: Company Access policies must not allow Everyone or any valid service token.',
        );
      }
      if (rule.group) {
        const id = text(object(rule.group, 'Access group').id, 'Access group ID');
        if (groups.has(id)) {
          throw new Error('platform: Access groups contain a recursive membership rule.');
        }
        if (checkedGroups.has(id)) {
          continue;
        }
        if (checkedGroups.size >= 100) {
          throw new Error('platform: Access group policy exceeds the inspection limit.');
        }
        groups.add(id);
        const group = object(await client.get(`groups/${encodeURIComponent(id)}`), 'Access group');
        await checkRules(group.include, depth + 1);
        await checkRules(group.require, depth + 1);
        if (!Array.isArray(group.include) || !group.include.length) {
          throw new Error('platform: Access groups must contain explicit identity rules.');
        }
        if (
          !(
            Array.isArray(group.require) &&
            group.require.some((entry) => identityRule(object(entry, 'group rule')))
          ) &&
          !group.include.every((entry) => identityRule(object(entry, 'group rule')))
        ) {
          throw new Error('platform: Access groups must restrict company identities.');
        }
        groups.delete(id);
        checkedGroups.add(id);
      }
    }
  };
  let allows = 0;
  for (const policy of policies) {
    if (!['allow', 'deny', 'non_identity', 'bypass'].includes(String(policy.decision))) {
      throw new Error('platform: Unsupported Access policy decision.');
    }
    if (policy.decision === 'bypass') {
      throw new Error('platform: A bypass policy cannot protect a Void platform.');
    }
    if (policy.decision !== 'allow') {
      continue;
    }
    allows++;
    await checkRules(policy.include);
    await checkRules(policy.require);
    if (
      !Array.isArray(policy.include) ||
      !policy.include.length ||
      (!(
        Array.isArray(policy.require) &&
        policy.require.some((entry) => identityRule(object(entry, 'policy rule')))
      ) &&
        !policy.include.every((entry) => identityRule(object(entry, 'policy rule'))))
    ) {
      throw new Error('platform: Select Access allow policies restricted to company identities.');
    }
  }
  if (!allows) {
    throw new Error('platform: Select at least one company Access allow policy.');
  }
}

function publicDestinations(application: ObjectValue): Array<string> {
  const destinations = Array.isArray(application.destinations) ? application.destinations : [];
  return [
    ...(typeof application.domain === 'string' ? [application.domain] : []),
    ...destinations.flatMap((value) => {
      const entry = object(value, 'Access destination');
      return entry.type === 'public' && typeof entry.uri === 'string' ? [entry.uri] : [];
    }),
  ];
}
function overlapsOrigin(destination: string, origin: string): boolean {
  const host = destination.split('/')[0]!;
  const pattern =
    '^' +
    host
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*') +
    '$';
  return new RegExp(pattern, 'i').test(new URL(origin).hostname);
}

export async function inspectPlatformAccess(
  client: PlatformAccessClient,
  input: Pick<PlatformAccessProvisionInput, 'identityProviderIds' | 'policyIds'>,
): Promise<{
  teamDomain: string;
  identityProviders: Array<{ id: string; name: string }>;
  policies: Array<ObjectValue>;
}> {
  const organization = object(await client.get('organizations'), 'Access organization');
  const authDomain = text(organization.auth_domain, 'Access team domain');
  const teamDomain = authDomain.startsWith('https://') ? authDomain : `https://${authDomain}`;
  // Reuse the runtime validator to avoid accepting a credential destination outside Access.
  parsePlatformAccessProtection({
    teamDomain,
    applications: [{ origin: 'https://validation.example.com', audience: 'validation' }],
  });
  const providers = await client.list('identity_providers');
  const identityProviders = providers.map((provider) => ({
    id: text(provider.id, 'identity provider ID'),
    name: text(provider.name ?? provider.id, 'identity provider name'),
  }));
  if (
    !input.identityProviderIds.length ||
    !input.policyIds.length ||
    input.identityProviderIds.length > 16 ||
    input.policyIds.length > 16 ||
    new Set(input.identityProviderIds).size !== input.identityProviderIds.length ||
    new Set(input.policyIds).size !== input.policyIds.length
  ) {
    throw new Error(
      'platform: Select explicit identity providers and company policies for Access.',
    );
  }
  if (
    input.identityProviderIds.some(
      (id) => !identityProviders.some((provider) => provider.id === id),
    )
  ) {
    throw new Error(
      'platform: A selected Access identity provider is unavailable in this account.',
    );
  }
  const policies = await Promise.all(
    input.policyIds.map(async (id) =>
      object(await client.get(`policies/${encodeURIComponent(id)}`), 'Access policy'),
    ),
  );
  await verifyCompanyAccessPolicies(client, policies);
  return { teamDomain, identityProviders, policies };
}

export async function provisionPlatformAccess(
  client: PlatformAccessClient,
  input: PlatformAccessProvisionInput,
  previous: PlatformAccessCheckpoint | undefined,
  save: (state: PlatformAccessCheckpoint) => void,
): Promise<PlatformAccessProvisionResult> {
  if (!input.login && !input.protection) {
    return { resources: [] };
  }
  if (client.accountId !== input.accountId) {
    throw new Error('platform: Access account selection does not match its management client.');
  }
  const inspected = await inspectPlatformAccess(client, input);
  const origins = [...new Set([new URL(input.apiUrl).origin, new URL(input.proxyUrl).origin])];
  for (const origin of origins) {
    if (!origin.startsWith('https://')) {
      throw new Error('platform: Access protection requires HTTPS platform origins.');
    }
  }
  const state: PlatformAccessCheckpoint = previous
    ? structuredClone(previous)
    : {
        version: 1,
        accountId: input.accountId,
        installationId: input.installationId,
        nonce: randomBytes(16).toString('hex'),
        resources: {},
      };
  if (
    state.version !== 1 ||
    state.accountId !== input.accountId ||
    state.installationId !== input.installationId ||
    !/^[a-f0-9]{32}$/.test(state.nonce)
  ) {
    throw new Error('platform: Access recovery data belongs to a different installation.');
  }
  save(state);
  const policies = input.policyIds.map((id, index) => ({ id, precedence: index + 1 }));
  const inventory = await client.list('apps');
  if (input.protection) {
    for (const app of inventory) {
      if (
        app.id === input.protection.applicationId ||
        app.id === state.resources.protection?.id ||
        app.name === state.resources.protection?.name
      ) {
        continue;
      }
      if (
        publicDestinations(app).some(
          (destination) =>
            origins.some((origin) => overlapsOrigin(destination, origin)) &&
            (destination.includes('/') ||
              origins.some((origin) => destination === new URL(origin).hostname)),
        )
      ) {
        throw new Error(
          'platform: An existing Access application overlaps a platform endpoint. Connect or reconcile it explicitly before provisioning protection.',
        );
      }
    }
  }
  const output: PlatformAccessProvisionResult = { resources: [] };

  const application = async (
    key: string,
    expected: ObjectValue,
    existingId?: string,
  ): Promise<ObjectValue> => {
    if (existingId) {
      const found = object(
        await client.get(`apps/${encodeURIComponent(existingId)}`),
        'Access application',
      );
      if (found.id !== existingId) {
        throw new Error('platform: Access returned a different application ID.');
      }
      return found;
    }
    const desiredHash = fingerprint(expected);
    let checkpoint = state.resources[key];
    if (checkpoint && checkpoint.fingerprint !== desiredHash) {
      throw new Error(
        'platform: Access setup changed after provisioning started. Connect the existing application explicitly rather than overwriting it.',
      );
    }
    if (checkpoint?.id) {
      const found = object(
        await client.get(`apps/${encodeURIComponent(checkpoint.id)}`),
        'Access application',
      );
      if (found.id !== checkpoint.id || found.name !== checkpoint.name) {
        throw new Error('platform: The recorded Access application changed ownership identity.');
      }
      return found;
    }
    if (checkpoint?.pending) {
      const matching = inventory.filter((app) => app.name === checkpoint!.name);
      if (matching.length !== 1) {
        throw new Error(
          'platform: An Access application creation has an uncertain outcome. Inspect Cloudflare and connect the existing application; no creation was retried.',
        );
      }
      checkpoint.id = text(matching[0]!.id, 'application ID');
      save(state);
      return object(
        await client.get(`apps/${encodeURIComponent(checkpoint.id)}`),
        'Access application',
      );
    }
    const name =
      `void-${input.installationId}-${key}`.slice(0, 90) + '-' + state.nonce.slice(0, 16);
    checkpoint = { name, fingerprint: desiredHash, pending: true };
    state.resources[key] = checkpoint;
    save(state);
    try {
      const created = object(
        await client.create('apps', { ...expected, name }),
        'Access application',
      );
      checkpoint.id = text(created.id, 'application ID');
      checkpoint.pending = false;
      if (created.saas_app) {
        const oidc = object(created.saas_app, 'OIDC application');
        checkpoint.clientId = text(oidc.client_id, 'OIDC client ID');
        checkpoint.clientSecret =
          typeof oidc.client_secret === 'string' ? oidc.client_secret : undefined;
      }
      save(state);
      return object(
        await client.get(`apps/${encodeURIComponent(checkpoint.id)}`),
        'Access application',
      );
    } catch (error) {
      if (
        error instanceof PlatformCloudflareApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 409, 429].includes(error.status)
      ) {
        checkpoint.pending = false;
        save(state);
      }
      throw error;
    }
  };

  const verifyApplication = async (app: ObjectValue, type: string, machineId?: string) => {
    if (app.type !== type || !sameSet(ids(app.allowed_idps), input.identityProviderIds)) {
      throw new Error(
        'platform: Access application identity-provider configuration does not match the reviewed plan.',
      );
    }
    const currentPolicies = await client.list(
      `apps/${encodeURIComponent(text(app.id, 'application ID'))}/policies`,
    );
    await verifyCompanyAccessPolicies(client, currentPolicies);
    const allowIds = currentPolicies
      .filter((policy) => policy.decision === 'allow' || policy.decision === 'deny')
      .map((policy) => text(policy.id, 'policy ID'));
    if (!sameSet(allowIds, input.policyIds)) {
      throw new Error(
        'platform: Access application policies do not match the reviewed company policies.',
      );
    }
    for (const policy of currentPolicies.filter((policy) => policy.decision === 'non_identity')) {
      const includes = Array.isArray(policy.include) ? policy.include : [];
      if (
        !machineId ||
        includes.length !== 1 ||
        object(includes[0], 'service policy').service_token === undefined ||
        object(object(includes[0], 'service policy').service_token, 'service token rule')
          .token_id !== machineId
      ) {
        throw new Error('platform: Access application contains an unexpected machine policy.');
      }
    }
    if (machineId && !currentPolicies.some((policy) => policy.decision === 'non_identity')) {
      throw new Error('platform: The platform service token is not admitted by Access.');
    }
  };

  if (input.login) {
    const key = `login-${input.login.id}`;
    const expected = {
      type: 'saas',
      allowed_idps: [...input.identityProviderIds],
      auto_redirect_to_identity: input.identityProviderIds.length === 1,
      policies,
      session_duration: '12h',
      saas_app: {
        auth_type: 'oidc',
        redirect_uris: [`${input.apiUrl}/auth/callback`],
        grant_types: ['authorization_code_with_pkce'],
        allow_pkce_without_client_secret: false,
        scopes: input.login.requiredGroups?.length
          ? ['openid', 'email', 'profile', 'groups']
          : ['openid', 'email', 'profile'],
      },
    };
    const app = await application(key, expected, input.login.applicationId);
    await verifyApplication(app, 'saas');
    const oidc = object(app.saas_app, 'OIDC configuration');
    if (
      oidc.auth_type !== 'oidc' ||
      !sameSet(ids(oidc.redirect_uris), [`${input.apiUrl}/auth/callback`]) ||
      !sameSet(ids(oidc.grant_types), ['authorization_code_with_pkce']) ||
      oidc.allow_pkce_without_client_secret === true
    ) {
      throw new Error('platform: Access OIDC redirect or flow settings do not match Void.');
    }
    const clientId = text(oidc.client_id, 'OIDC client ID');
    const clientSecret = input.login.clientSecret ?? state.resources[key]?.clientSecret;
    if (!clientSecret) {
      throw new Error(
        'platform: The Access application exists but its client secret was not recovered. Supply its secret explicitly; no duplicate application was created.',
      );
    }
    output.login = {
      configuration: parsePlatformLoginConfiguration({
        id: input.login.id,
        kind: 'cloudflare-access',
        label: input.login.label,
        issuer: `${inspected.teamDomain}/cdn-cgi/access/sso/oidc/${clientId}`,
        clientId,
        requiredGroups: input.login.requiredGroups ?? [],
      }),
      clientSecret,
    };
  }

  if (input.protection) {
    let service = input.serviceToken;
    const tokenKey = 'service-token';
    if (!service) {
      let saved = state.resources[tokenKey];
      if (!saved) {
        saved = {
          name: `void-${input.installationId}-access-probes-${state.nonce.slice(0, 16)}`,
          fingerprint: fingerprint({ origins }),
          pending: true,
        };
        state.resources[tokenKey] = saved;
        save(state);
        const created = object(
          await client.create('service_tokens', { name: saved.name, duration: '8760h' }),
          'Access service token',
        );
        saved.id = text(created.id, 'service token ID');
        saved.clientId = text(created.client_id, 'service token client ID');
        saved.clientSecret = text(created.client_secret, 'service token secret');
        saved.pending = false;
        save(state);
      }
      if (!saved.id || !saved.clientId || !saved.clientSecret) {
        const tokens = await client.list('service_tokens');
        const found = tokens.filter((token) => token.name === saved!.name);
        if (found.length === 1) {
          saved.id = text(found[0]!.id, 'service token ID');
          save(state);
        }
        throw new Error(
          'platform: Access service-token creation has an uncertain outcome or its secret was lost. Supply an existing admitted service token; no creation was retried.',
        );
      }
      service = { id: saved.id, clientId: saved.clientId, clientSecret: saved.clientSecret };
    }
    const expected = {
      type: 'self_hosted',
      domain: new URL(input.apiUrl).hostname,
      destinations: origins.map((origin) => ({ type: 'public', uri: new URL(origin).hostname })),
      allowed_idps: [...input.identityProviderIds],
      auto_redirect_to_identity: input.identityProviderIds.length === 1,
      session_duration: '12h',
      policies: [
        ...policies,
        {
          name: 'Void installer and CI',
          decision: 'non_identity',
          precedence: 0,
          include: [{ service_token: { token_id: service.id } }],
        },
      ],
    };
    const app = await application('protection', expected, input.protection.applicationId);
    await verifyApplication(app, 'self_hosted', service.id);
    const covered = publicDestinations(app);
    if (origins.some((origin) => !covered.includes(new URL(origin).hostname))) {
      throw new Error(
        'platform: Access must protect both the API and proxy origins without path exclusions.',
      );
    }
    const audience = text(app.aud, 'application audience');
    output.protection = parsePlatformAccessProtection({
      teamDomain: inspected.teamDomain,
      applications: origins.map((origin) => ({ origin, audience })),
    })!;
    output.credentials = Object.fromEntries(
      origins.map((origin) => [
        origin,
        { CF_ACCESS_CLIENT_ID: service.clientId, CF_ACCESS_CLIENT_SECRET: service.clientSecret },
      ]),
    );
  }
  output.resources = Object.entries(state.resources).flatMap(([key, value]) =>
    value.id ? [{ key, id: value.id, name: value.name, adopted: value.adopted === true }] : [],
  );
  if (input.login?.applicationId) {
    output.resources = [
      ...output.resources,
      {
        key: `login-${input.login.id}`,
        id: input.login.applicationId,
        name: input.login.label,
        adopted: true,
      },
    ];
  }
  if (input.protection?.applicationId) {
    output.resources = [
      ...output.resources,
      {
        key: 'protection',
        id: input.protection.applicationId,
        name: 'Existing platform protection',
        adopted: true,
      },
    ];
  }
  return output;
}
