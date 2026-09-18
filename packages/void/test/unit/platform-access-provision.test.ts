import { describe, expect, it } from 'vite-plus/test';
import {
  PlatformAccessClient,
  provisionPlatformAccess,
  type PlatformAccessCheckpoint,
  type PlatformAccessProvisionInput,
} from '../../src/cli/platform-access-provision.ts';

type RecordValue = Record<string, unknown>;
function fixture() {
  const apps = new Map<string, RecordValue>();
  const tokens = new Map<string, RecordValue>();
  const policy: RecordValue = {
    id: 'employees',
    name: 'Employees and managed devices',
    decision: 'allow',
    include: [{ email_domain: { domain: 'example.com' } }],
    require: [{ device_posture: { integration_uid: 'managed-devices' } }],
  };
  const calls: Array<{ method: string; path: string; body?: RecordValue }> = [];
  let loseApplicationResponse = false;
  let sequence = 0;
  const client = new PlatformAccessClient(
    {
      request: async <T>(path: string, init?: RequestInit): Promise<T> => {
        const target = path.split('?')[0]!.replace('/accounts/account/access/', '');
        const method = init?.method ?? 'GET';
        const body = init?.body ? (JSON.parse(String(init.body)) as RecordValue) : undefined;
        calls.push({ method, path: target, body });
        let result: unknown;
        if (target === 'organizations') {
          result = { auth_domain: 'company.cloudflareaccess.com' };
        } else if (target === 'identity_providers') {
          result = [{ id: 'company-idp', name: 'Company SSO' }];
        } else if (target === 'policies/employees') {
          result = policy;
        } else if (target === 'apps' && method === 'GET') {
          result = [...apps.values()];
        } else if (target === 'service_tokens' && method === 'GET') {
          result = [...tokens.values()];
        } else if (target === 'service_tokens' && method === 'POST') {
          const token = {
            ...body,
            id: `token-${++sequence}`,
            client_id: 'ci.access',
            client_secret: 'service-secret',
          };
          tokens.set(token.id, token);
          result = token;
        } else if (target === 'apps' && method === 'POST') {
          const id = `app-${++sequence}`;
          const app: RecordValue = { ...body, id, aud: `${id}-audience` };
          const oidc = app.saas_app as RecordValue | undefined;
          if (oidc) {
            app.saas_app = { ...oidc, client_id: `${id}-client`, client_secret: 'oidc-secret' };
          }
          apps.set(id, app);
          if (loseApplicationResponse) {
            loseApplicationResponse = false;
            throw new Error('response lost');
          }
          result = app;
        } else if (target.startsWith('apps/') && target.endsWith('/policies')) {
          const app = apps.get(target.split('/')[1]!)!;
          result = (app.policies as Array<RecordValue>).map((entry, index) =>
            entry.id === 'employees' ? policy : { id: `inline-${index}`, ...entry },
          );
        } else if (target.startsWith('apps/')) {
          const app = structuredClone(apps.get(target.slice(5))!);
          if (app.saas_app) {
            delete (app.saas_app as RecordValue).client_secret;
          }
          result = app;
        } else {
          throw new Error(`Unexpected request ${method} ${target}`);
        }
        return structuredClone(result) as T;
      },
    },
    'account',
  );
  return {
    client,
    calls,
    apps,
    tokens,
    policy,
    loseNextApplicationResponse() {
      loseApplicationResponse = true;
    },
  };
}
const base: PlatformAccessProvisionInput = {
  accountId: 'account',
  installationId: 'team-installation',
  apiUrl: 'https://api.example.com',
  proxyUrl: 'https://proxy.example.com',
  identityProviderIds: ['company-idp'],
  policyIds: ['employees'],
};

describe('Cloudflare Access provisioning', () => {
  it('performs no Access probes or writes when neither capability is selected', async () => {
    const env = fixture();
    expect(
      await provisionPlatformAccess(env.client, base, undefined, () => {
        throw new Error('No checkpoint expected');
      }),
    ).toEqual({ resources: [] });
    expect(env.calls).toHaveLength(0);
  });
  it('creates OIDC login without a perimeter application or service token', async () => {
    const env = fixture();
    let state: PlatformAccessCheckpoint | undefined;
    const input = { ...base, login: { id: 'access', label: 'Company Access' } };
    const result = await provisionPlatformAccess(env.client, input, state, (value) => {
      state = structuredClone(value);
    });
    expect(result.login?.configuration).toMatchObject({
      kind: 'cloudflare-access',
      issuer: 'https://company.cloudflareaccess.com/cdn-cgi/access/sso/oidc/app-1-client',
    });
    expect(result.login?.clientSecret).toBe('oidc-secret');
    expect(result.protection).toBeUndefined();
    expect(env.tokens.size).toBe(0);
    const repeated = await provisionPlatformAccess(env.client, input, state, (value) => {
      state = structuredClone(value);
    });
    expect(repeated.login).toEqual(result.login);
    expect(env.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('creates independent protection with a narrow machine policy and origin-scoped credentials', async () => {
    const env = fixture();
    let saved: PlatformAccessCheckpoint | undefined;
    const result = await provisionPlatformAccess(
      env.client,
      { ...base, protection: {} },
      undefined,
      (state) => {
        saved = structuredClone(state);
      },
    );
    expect(result.login).toBeUndefined();
    expect(result.protection?.applications.map((app) => app.origin)).toEqual([
      base.apiUrl,
      base.proxyUrl,
    ]);
    expect(Object.keys(result.credentials!)).toEqual([base.apiUrl, base.proxyUrl]);
    const app = [...env.apps.values()][0]!;
    expect(app.policies).toEqual([
      { id: 'employees', precedence: 1 },
      {
        name: 'Void installer and CI',
        decision: 'non_identity',
        precedence: 0,
        include: [{ service_token: { token_id: 'token-1' } }],
      },
    ]);
    expect(env.policy.require).toEqual([
      { device_posture: { integration_uid: 'managed-devices' } },
    ]);
    expect(saved?.resources['service-token']?.clientSecret).toBe('service-secret');
  });

  it('rejects broad or bypass company policies before any mutation', async () => {
    for (const replacement of [
      { decision: 'bypass' },
      { include: [{ everyone: {} }] },
      { include: [{ ip: { ip: '0.0.0.0/0' } }] },
    ]) {
      const env = fixture();
      Object.assign(env.policy, replacement);
      await expect(
        provisionPlatformAccess(env.client, { ...base, protection: {} }, undefined, () => {}),
      ).rejects.toThrow();
      expect(env.calls.some((call) => call.method === 'POST')).toBe(false);
    }
  });

  it('rejects more specific overlapping Access apps before creating even an OIDC app', async () => {
    const env = fixture();
    env.apps.set('foreign', {
      id: 'foreign',
      name: 'Existing admin route',
      domain: 'api.example.com/admin',
      type: 'self_hosted',
    });
    await expect(
      provisionPlatformAccess(
        env.client,
        { ...base, login: { id: 'access', label: 'Access' }, protection: {} },
        undefined,
        () => {},
      ),
    ).rejects.toThrow('overlaps');
    expect(env.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('reconciles an ambiguous create without duplicating the app or inventing its secret', async () => {
    const env = fixture();
    let state: PlatformAccessCheckpoint | undefined;
    const save = (value: PlatformAccessCheckpoint) => {
      state = structuredClone(value);
    };
    const input = { ...base, login: { id: 'access', label: 'Access' } };
    env.loseNextApplicationResponse();
    await expect(provisionPlatformAccess(env.client, input, state, save)).rejects.toThrow(
      'response lost',
    );
    await expect(provisionPlatformAccess(env.client, input, state, save)).rejects.toThrow(
      'secret was not recovered',
    );
    expect(env.apps.size).toBe(1);
    expect(env.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    const recovered = await provisionPlatformAccess(
      env.client,
      { ...input, login: { ...input.login, clientSecret: 'recovered-secret' } },
      state,
      save,
    );
    expect(recovered.login?.clientSecret).toBe('recovered-secret');
    expect(env.apps.size).toBe(1);
  });

  it('connects an existing application without mutating its policies', async () => {
    const env = fixture();
    env.apps.set('external', {
      id: 'external',
      name: 'Externally managed',
      type: 'saas',
      allowed_idps: ['company-idp'],
      policies: [{ id: 'employees' }],
      saas_app: {
        auth_type: 'oidc',
        client_id: 'external-client',
        redirect_uris: [`${base.apiUrl}/auth/callback`],
        grant_types: ['authorization_code_with_pkce'],
        allow_pkce_without_client_secret: false,
      },
    });
    const result = await provisionPlatformAccess(
      env.client,
      {
        ...base,
        login: {
          id: 'access',
          label: 'Access',
          applicationId: 'external',
          clientSecret: 'external-secret',
        },
      },
      undefined,
      () => {},
    );
    expect(result.resources).toMatchObject([{ id: 'external', adopted: true }]);
    expect(env.calls.some((call) => call.method !== 'GET')).toBe(false);
  });
});
