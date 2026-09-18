/** Platform login and perimeter configuration are independent of app authentication. */
export const PLATFORM_LOGIN_KINDS = ['github', 'google', 'oidc', 'cloudflare-access'] as const;
export type PlatformLoginKind = (typeof PLATFORM_LOGIN_KINDS)[number];

export type PlatformLoginConfiguration = Readonly<{
  id: string;
  kind: PlatformLoginKind;
  label: string;
  clientId: string;
  /** Exact OIDC issuer; GitHub does not use OIDC. */
  issuer?: string;
  /** Google Workspace hosted domains, checked against the signed hd claim. */
  allowedDomains: ReadonlyArray<string>;
  /** An identity must belong to at least one configured group. */
  requiredGroups: ReadonlyArray<string>;
}>;

export type PlatformLoginDescriptor = Readonly<{
  id: string;
  kind: PlatformLoginKind;
  label: string;
}>;

export type PlatformAccessProtection = Readonly<{
  teamDomain: string;
  /** Each externally reachable platform origin has its own expected application audience. */
  applications: ReadonlyArray<Readonly<{ origin: string; audience: string }>>;
}>;

export type PlatformAdmissionPolicy =
  | Readonly<{ mode: 'restricted' | 'public' }>
  | Readonly<{
      mode: 'company';
      /** Explicitly trusted connections whose own configured restrictions must pass. */
      connections: ReadonlyArray<string>;
      /** A verified human Access identity qualifies, independently of the login method. */
      access: boolean;
    }>;

export const DEFAULT_PLATFORM_SESSION_SECONDS: number = 30 * 24 * 60 * 60;
export const GOOGLE_OIDC_ISSUER = 'https://accounts.google.com';

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string, maximum = 512): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    throw new Error(`${name} must be a nonempty string of at most ${maximum} characters.`);
  }
  return value.trim();
}

function strings(value: unknown, name: string, maximum = 100): Array<string> {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${name} must be an array of at most ${maximum} strings.`);
  }
  const result = value.map((entry) => string(entry, name));
  if (new Set(result).size !== result.length) {
    throw new Error(`${name} must not contain duplicates.`);
  }
  return result;
}

export function parsePlatformLoginId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
    throw new Error(
      'Login connection IDs must start with a letter and use 1–64 lowercase letters, digits, or hyphens.',
    );
  }
  return value;
}

/** HTTPS syntax validation; outbound network policy must additionally validate resolved endpoints. */
export function parsePlatformIdentityUrl(value: unknown, name: string, originOnly = false): string {
  const input = string(value, name, 2048);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`${name} must be a credential-free HTTPS URL.`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (originOnly && url.pathname !== '/')
  ) {
    throw new Error(
      `${name} must be a credential-free HTTPS ${originOnly ? 'origin' : 'URL'} without query or fragment.`,
    );
  }
  // OIDC issuer strings are compared exactly, including a significant trailing slash.
  return originOnly ? url.origin : input;
}

export function parsePlatformLoginDescriptor(value: unknown): PlatformLoginDescriptor {
  const entry = record(value, 'Login connection');
  const id = parsePlatformLoginId(entry.id);
  if (!PLATFORM_LOGIN_KINDS.includes(entry.kind as PlatformLoginKind)) {
    throw new Error('Login kind must be github, google, oidc, or cloudflare-access.');
  }
  const kind = entry.kind as PlatformLoginKind;
  if ((kind === 'github' || kind === 'google') && id !== kind) {
    throw new Error(`${kind} uses the fixed connection ID ${kind}.`);
  }
  return { id, kind, label: string(entry.label, 'Login label', 100) };
}

export function parsePlatformLoginConfiguration(value: unknown): PlatformLoginConfiguration {
  const entry = record(value, 'Login configuration');
  const descriptor = parsePlatformLoginDescriptor(entry);
  const clientId = string(entry.clientId, 'Client ID');
  const allowedDomains = strings(entry.allowedDomains ?? [], 'Allowed domains').map((domain) => {
    const normalized = domain.toLowerCase();
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(normalized)) {
      throw new Error('Allowed domains must be exact domain names, without wildcards.');
    }
    return normalized;
  });
  if (new Set(allowedDomains).size !== allowedDomains.length) {
    throw new Error('Allowed domains must not contain duplicates.');
  }
  const requiredGroups = strings(entry.requiredGroups ?? [], 'Required groups');
  if (descriptor.kind !== 'google' && allowedDomains.length > 0) {
    throw new Error('Workspace domain restrictions are only supported by Google login.');
  }
  if ((descriptor.kind === 'github' || descriptor.kind === 'google') && requiredGroups.length > 0) {
    throw new Error('Group restrictions require an OIDC or Cloudflare Access connection.');
  }
  let issuer: string | undefined;
  if (descriptor.kind === 'google') {
    if (entry.issuer !== undefined && entry.issuer !== GOOGLE_OIDC_ISSUER) {
      throw new Error('Google login uses the Google issuer.');
    }
    issuer = GOOGLE_OIDC_ISSUER;
  } else if (descriptor.kind === 'github') {
    if (entry.issuer !== undefined) {
      throw new Error('GitHub login does not accept an OIDC issuer.');
    }
  } else {
    issuer = parsePlatformIdentityUrl(entry.issuer, 'OIDC issuer');
  }
  return { ...descriptor, clientId, ...(issuer ? { issuer } : {}), allowedDomains, requiredGroups };
}

export function parsePlatformAccessProtection(value: unknown): PlatformAccessProtection | null {
  if (value === null) {
    return null;
  }
  const entry = record(value, 'Access protection');
  const teamDomain = parsePlatformIdentityUrl(entry.teamDomain, 'Access team domain', true);
  const host = new URL(teamDomain).hostname;
  if (
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(host) ||
    new URL(teamDomain).port
  ) {
    throw new Error('Access team domain must be an HTTPS cloudflareaccess.com team origin.');
  }
  if (
    !Array.isArray(entry.applications) ||
    entry.applications.length === 0 ||
    entry.applications.length > 20
  ) {
    throw new Error('Access protection requires between 1 and 20 protected origins.');
  }
  const applications = entry.applications.map((value) => {
    const application = record(value, 'Access application');
    return {
      origin: parsePlatformIdentityUrl(application.origin, 'Protected origin', true),
      audience: string(application.audience, 'Access application audience'),
    };
  });
  if (new Set(applications.map((app) => app.origin)).size !== applications.length) {
    throw new Error('Each protected origin must have exactly one Access application.');
  }
  return { teamDomain, applications };
}

export function parsePlatformAdmissionPolicy(value: unknown): PlatformAdmissionPolicy {
  const entry = record(value, 'Admission policy');
  if (entry.mode === 'restricted' || entry.mode === 'public') {
    return { mode: entry.mode };
  }
  if (entry.mode !== 'company' || typeof entry.access !== 'boolean') {
    throw new Error('Admission policy must select restricted, company, or public signup.');
  }
  const connections = strings(entry.connections, 'Company connections').map(parsePlatformLoginId);
  if (!entry.access && connections.length === 0) {
    throw new Error('Company admission requires a trusted connection or Access protection.');
  }
  return { mode: 'company', connections, access: entry.access };
}

/** Run inside the settings mutation transaction, using the resulting enabled connections. */
export function validatePlatformAdmissionPolicy(
  policy: PlatformAdmissionPolicy,
  enabledConnections: ReadonlyArray<PlatformLoginConfiguration>,
  protection: PlatformAccessProtection | null,
): void {
  if (policy.mode !== 'company') {
    return;
  }
  if (policy.access && !protection) {
    throw new Error('Company admission through Access requires enabled protection.');
  }
  for (const id of policy.connections) {
    const connection = enabledConnections.find((entry) => entry.id === id);
    if (!connection) {
      throw new Error(`Company admission requires enabled connection ${id}.`);
    }
    if (
      connection.kind === 'github' ||
      (connection.kind === 'google' && connection.allowedDomains.length === 0)
    ) {
      throw new Error('Unrestricted social login does not establish company membership.');
    }
  }
}
