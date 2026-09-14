const DEFAULT_API_BASE = 'https://api.cloudflare.com/client/v4';

type CloudflareEnvelope<T> = Readonly<{
  errors?: ReadonlyArray<{ code?: number; message?: string }>;
  result?: T;
  result_info?: { cursor?: string };
  success?: boolean;
}>;

export class PlatformCloudflareApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'PlatformCloudflareApiError';
    this.status = status;
  }
}

export type CloudflareAccount = Readonly<{ id: string; name: string }>;
export type CloudflareNamedResource = Readonly<{ id: string; name: string }>;
export type CloudflareDnsRecord = CloudflareNamedResource &
  Readonly<{
    content: string;
    proxied: boolean;
    type: string;
  }>;
export type CloudflareZone = Readonly<{
  id: string;
  name: string;
  nameServers: ReadonlyArray<string>;
  status: string;
}>;

export class PlatformCloudflareClient {
  readonly #apiBase: string;
  readonly #fetcher: typeof fetch;
  readonly #token: string;

  constructor(token: string, options?: { apiBase?: string; fetcher?: typeof fetch }) {
    if (!token) {
      throw new Error(
        'platform: CLOUDFLARE_API_TOKEN is required. The installed control plane also uses this scoped token to provision app resources.',
      );
    }
    this.#token = token;
    this.#apiBase = (
      options?.apiBase ??
      process.env.CLOUDFLARE_API_BASE_URL ??
      DEFAULT_API_BASE
    ).replace(/\/+$/, '');
    this.#fetcher = options?.fetcher ?? fetch;
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.#fetcher(`${this.#apiBase}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.#token}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
      signal: init?.signal ?? AbortSignal.timeout(30_000),
    });
    let envelope: CloudflareEnvelope<T>;
    try {
      envelope = (await response.json()) as CloudflareEnvelope<T>;
    } catch {
      throw new PlatformCloudflareApiError(
        `Cloudflare returned a non-JSON response (HTTP ${response.status}).`,
        response.status,
      );
    }
    if (!response.ok || envelope.success !== true || envelope.result === undefined) {
      const details =
        envelope.errors
          ?.map((error) => error.message)
          .filter(Boolean)
          .join(', ') || `HTTP ${response.status}`;
      throw new PlatformCloudflareApiError(`Cloudflare API error: ${details}`, response.status);
    }
    return envelope.result;
  }

  async verifyToken(): Promise<void> {
    await this.request('/user/tokens/verify');
  }

  async listAccounts(): Promise<ReadonlyArray<CloudflareAccount>> {
    const entries: Array<{ id?: unknown; name?: unknown }> = [];
    for (let page = 1; ; page++) {
      const result = await this.request<ReadonlyArray<{ id?: unknown; name?: unknown }>>(
        `/accounts?page=${page}&per_page=50`,
      );
      entries.push(...result);
      if (result.length < 50) {
        break;
      }
    }
    return entries.map((entry) => ({
      id: requiredString(entry.id, 'Cloudflare account id'),
      name: requiredString(entry.name, 'Cloudflare account name'),
    }));
  }

  async getWorkersSubdomain(accountId: string): Promise<string> {
    const result = await this.request<{ subdomain?: unknown }>(
      `/accounts/${encodeURIComponent(accountId)}/workers/subdomain`,
    );
    return requiredString(result.subdomain, 'Cloudflare workers.dev subdomain');
  }

  async listAiGateways(accountId: string): Promise<ReadonlyArray<CloudflareNamedResource>> {
    const entries: Array<{ id?: unknown }> = [];
    for (let page = 1; ; page++) {
      const result = await this.request<ReadonlyArray<{ id?: unknown }>>(
        `/accounts/${encodeURIComponent(accountId)}/ai-gateway/gateways?page=${page}&per_page=50`,
      );
      entries.push(...result);
      if (result.length < 50) {
        break;
      }
    }
    return entries.map((entry) => ({
      id: requiredString(entry.id, 'AI Gateway id'),
      name: requiredString(entry.id, 'AI Gateway id'),
    }));
  }

  async createAiGateway(accountId: string, id: string): Promise<CloudflareNamedResource> {
    const result = await this.request<{ id?: unknown }>(
      `/accounts/${encodeURIComponent(accountId)}/ai-gateway/gateways`,
      {
        method: 'POST',
        body: JSON.stringify({
          cache_invalidate_on_update: false,
          cache_ttl: null,
          collect_logs: true,
          id,
          rate_limiting_interval: null,
          rate_limiting_limit: null,
        }),
      },
    );
    return {
      id: requiredString(result.id, 'AI Gateway id'),
      name: id,
    };
  }

  async findZone(accountId: string, name: string): Promise<CloudflareZone | null> {
    const result = await this.request<ReadonlyArray<Record<string, unknown>>>(
      `/zones?account.id=${encodeURIComponent(accountId)}&name=${encodeURIComponent(name)}&per_page=50`,
    );
    const exact = result.find((zone) => zone.name === name);
    return exact ? parseZone(exact) : null;
  }

  async createZone(accountId: string, name: string): Promise<CloudflareZone> {
    return parseZone(
      await this.request<Record<string, unknown>>('/zones', {
        method: 'POST',
        body: JSON.stringify({ account: { id: accountId }, name, type: 'full' }),
      }),
    );
  }

  async listDnsRecords(zoneId: string, name: string): Promise<ReadonlyArray<CloudflareDnsRecord>> {
    const query = new URLSearchParams({ name, per_page: '100' });
    const result = await this.request<ReadonlyArray<Record<string, unknown>>>(
      `/zones/${encodeURIComponent(zoneId)}/dns_records?${query}`,
    );
    return result.map(parseDnsRecord);
  }

  async createDnsRecord(zoneId: string, name: string): Promise<CloudflareDnsRecord> {
    return parseDnsRecord(
      await this.request<Record<string, unknown>>(
        `/zones/${encodeURIComponent(zoneId)}/dns_records`,
        {
          method: 'POST',
          body: JSON.stringify({ content: '100::', name, proxied: true, ttl: 1, type: 'AAAA' }),
        },
      ),
    );
  }

  async listKvNamespaces(
    accountId: string,
    title?: string,
  ): Promise<ReadonlyArray<CloudflareNamedResource>> {
    const entries: Array<{ id?: unknown; title?: unknown }> = [];
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({ page: String(page), per_page: '100' });
      if (title) {
        query.set('title', title);
      }
      const result = await this.request<ReadonlyArray<{ id?: unknown; title?: unknown }>>(
        `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces?${query}`,
      );
      entries.push(...result);
      if (result.length < 100) {
        break;
      }
    }
    return entries.map((entry) => ({
      id: requiredString(entry.id, 'KV namespace id'),
      name: requiredString(entry.title, 'KV namespace title'),
    }));
  }

  async createKvNamespace(accountId: string, title: string): Promise<CloudflareNamedResource> {
    const result = await this.request<{ id?: unknown; title?: unknown }>(
      `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces`,
      { method: 'POST', body: JSON.stringify({ title }) },
    );
    return {
      id: requiredString(result.id, 'KV namespace id'),
      name: typeof result.title === 'string' ? result.title : title,
    };
  }

  async listR2Buckets(accountId: string): Promise<ReadonlyArray<CloudflareNamedResource>> {
    const buckets: Array<{ name?: unknown }> = [];
    let startAfter = '';
    for (;;) {
      const query = new URLSearchParams({ direction: 'asc', order: 'name', per_page: '1000' });
      if (startAfter) {
        query.set('start_after', startAfter);
      }
      const result = await this.request<
        { buckets?: ReadonlyArray<{ name?: unknown }> } | ReadonlyArray<{ name?: unknown }>
      >(`/accounts/${encodeURIComponent(accountId)}/r2/buckets?${query}`);
      const page = Array.isArray(result)
        ? result
        : 'buckets' in result
          ? (result.buckets ?? [])
          : [];
      buckets.push(...page);
      if (page.length < 1000) {
        break;
      }
      const next = requiredString(page.at(-1)?.name, 'R2 bucket name');
      if (next === startAfter) {
        throw new Error('platform: Cloudflare returned a non-advancing R2 bucket page.');
      }
      startAfter = next;
    }
    return buckets.map((entry) => {
      const name = requiredString(entry.name, 'R2 bucket name');
      return { id: name, name };
    });
  }

  async createR2Bucket(accountId: string, name: string): Promise<CloudflareNamedResource> {
    const result = await this.request<{ name?: unknown }>(
      `/accounts/${encodeURIComponent(accountId)}/r2/buckets`,
      { method: 'POST', body: JSON.stringify({ name }) },
    );
    const resultName = typeof result.name === 'string' ? result.name : name;
    return { id: resultName, name: resultName };
  }

  async listQueues(
    accountId: string,
    name: string,
  ): Promise<ReadonlyArray<CloudflareNamedResource>> {
    const result = await this.request<ReadonlyArray<{ queue_id?: unknown; queue_name?: unknown }>>(
      `/accounts/${encodeURIComponent(accountId)}/queues?name=${encodeURIComponent(name)}&per_page=100`,
    );
    return result.map((entry) => ({
      id: requiredString(entry.queue_id, 'Queue id'),
      name: requiredString(entry.queue_name, 'Queue name'),
    }));
  }

  async createQueue(accountId: string, name: string): Promise<CloudflareNamedResource> {
    const result = await this.request<{ queue_id?: unknown; queue_name?: unknown }>(
      `/accounts/${encodeURIComponent(accountId)}/queues`,
      { method: 'POST', body: JSON.stringify({ queue_name: name }) },
    );
    return {
      id: requiredString(result.queue_id, 'Queue id'),
      name: typeof result.queue_name === 'string' ? result.queue_name : name,
    };
  }

  async listDispatchNamespaces(accountId: string): Promise<ReadonlyArray<CloudflareNamedResource>> {
    const result = await this.request<
      ReadonlyArray<{ namespace_id?: unknown; namespace_name?: unknown }>
    >(`/accounts/${encodeURIComponent(accountId)}/workers/dispatch/namespaces`);
    return result.map((entry) => ({
      id: requiredString(entry.namespace_id, 'Dispatch namespace id'),
      name: requiredString(entry.namespace_name, 'Dispatch namespace name'),
    }));
  }

  async createDispatchNamespace(accountId: string, name: string): Promise<CloudflareNamedResource> {
    const result = await this.request<{ namespace_id?: unknown; namespace_name?: unknown }>(
      `/accounts/${encodeURIComponent(accountId)}/workers/dispatch/namespaces`,
      { method: 'POST', body: JSON.stringify({ name }) },
    );
    return {
      id: requiredString(result.namespace_id, 'Dispatch namespace id'),
      name: typeof result.namespace_name === 'string' ? result.namespace_name : name,
    };
  }

  async listHyperdriveConfigs(accountId: string): Promise<ReadonlyArray<CloudflareNamedResource>> {
    const entries: Array<{ id?: unknown; name?: unknown }> = [];
    for (let page = 1; ; page++) {
      const result = await this.request<ReadonlyArray<{ id?: unknown; name?: unknown }>>(
        `/accounts/${encodeURIComponent(accountId)}/hyperdrive/configs?page=${page}&per_page=50`,
      );
      entries.push(...result);
      if (result.length < 50) {
        break;
      }
    }
    return entries.map((entry) => ({
      id: requiredString(entry.id, 'Hyperdrive id'),
      name: requiredString(entry.name, 'Hyperdrive name'),
    }));
  }

  async createHyperdrive(
    accountId: string,
    name: string,
    connectionString: string,
  ): Promise<CloudflareNamedResource> {
    const parsed = parsePostgresConnectionString(connectionString);
    const result = await this.request<{ id?: unknown; name?: unknown }>(
      `/accounts/${encodeURIComponent(accountId)}/hyperdrive/configs`,
      {
        method: 'POST',
        body: JSON.stringify({
          name,
          origin: {
            database: parsed.database,
            host: parsed.host,
            password: parsed.password,
            port: parsed.port,
            scheme: 'postgresql',
            user: parsed.user,
          },
        }),
      },
    );
    return {
      id: requiredString(result.id, 'Hyperdrive id'),
      name: typeof result.name === 'string' ? result.name : name,
    };
  }

  async listWorkerNames(accountId: string): Promise<ReadonlyArray<string>> {
    const result = await this.request<ReadonlyArray<{ id?: unknown }>>(
      `/accounts/${encodeURIComponent(accountId)}/workers/scripts`,
    );
    return result.map((entry) => requiredString(entry.id, 'Worker name'));
  }

  async putKvValue(
    accountId: string,
    namespaceId: string,
    key: string,
    value: string,
  ): Promise<void> {
    await this.request(
      `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/values/${encodeURIComponent(key)}`,
      { method: 'PUT', body: value, headers: { 'Content-Type': 'application/json' } },
    );
  }

  async getKvValue(accountId: string, namespaceId: string, key: string): Promise<string | null> {
    const response = await this.#fetcher(
      `${this.#apiBase}/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/values/${encodeURIComponent(key)}`,
      {
        headers: { Authorization: `Bearer ${this.#token}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new PlatformCloudflareApiError(
        `Cloudflare API error reading the installation manifest (HTTP ${response.status}).`,
        response.status,
      );
    }
    return response.text();
  }

  async deleteKvValue(accountId: string, namespaceId: string, key: string): Promise<void> {
    try {
      await this.request(
        `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/values/${encodeURIComponent(key)}`,
        { method: 'DELETE' },
      );
    } catch (error) {
      if (error instanceof PlatformCloudflareApiError && error.status === 404) {
        return;
      }
      throw error;
    }
  }

  async emptyR2Bucket(accountId: string, bucketName: string): Promise<void> {
    let cursor = '';
    const observedCursors = new Set<string>();
    for (;;) {
      const query = new URLSearchParams({ per_page: '1000' });
      if (cursor) {
        query.set('cursor', cursor);
      }
      const response = await this.#fetcher(
        `${this.#apiBase}/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucketName)}/objects?${query}`,
        {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.#token}`,
          },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (response.status === 404) {
        return;
      }
      const envelope = (await response.json()) as CloudflareEnvelope<
        ReadonlyArray<{ key?: unknown }>
      >;
      if (!response.ok || envelope.success !== true || !Array.isArray(envelope.result)) {
        const details =
          envelope.errors
            ?.map((error) => error.message)
            .filter(Boolean)
            .join(', ') || `HTTP ${response.status}`;
        throw new PlatformCloudflareApiError(
          `Cloudflare API error listing R2 objects: ${details}`,
          response.status,
        );
      }
      const keys = envelope.result.map((object) => requiredString(object.key, 'R2 object key'));
      for (let offset = 0; offset < keys.length; offset += 25) {
        await Promise.all(
          keys
            .slice(offset, offset + 25)
            .map((key) => this.deleteR2Object(accountId, bucketName, key)),
        );
      }
      const nextCursor = envelope.result_info?.cursor ?? '';
      if (!nextCursor) {
        return;
      }
      if (observedCursors.has(nextCursor)) {
        throw new Error('platform: Cloudflare returned a repeated R2 object cursor.');
      }
      observedCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  private async deleteR2Object(accountId: string, bucketName: string, key: string): Promise<void> {
    const response = await this.#fetcher(
      `${this.#apiBase}/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucketName)}/objects/${encodeURIComponent(key)}`,
      {
        headers: { Authorization: `Bearer ${this.#token}` },
        method: 'DELETE',
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new PlatformCloudflareApiError(
        `Cloudflare API error deleting an R2 object (HTTP ${response.status}).`,
        response.status,
      );
    }
  }

  async deleteResource(
    accountId: string,
    kind: string,
    id: string,
    zoneId?: string,
  ): Promise<void> {
    const account = encodeURIComponent(accountId);
    const encoded = encodeURIComponent(id);
    const path =
      kind === 'kv-namespace'
        ? `/accounts/${account}/storage/kv/namespaces/${encoded}`
        : kind === 'dns-record'
          ? zoneId
            ? `/zones/${encodeURIComponent(zoneId)}/dns_records/${encoded}`
            : null
          : kind === 'ai-gateway'
            ? `/accounts/${account}/ai-gateway/gateways/${encoded}`
            : kind === 'r2-bucket'
              ? `/accounts/${account}/r2/buckets/${encoded}`
              : kind === 'queue'
                ? `/accounts/${account}/queues/${encoded}`
                : kind === 'dispatch-namespace'
                  ? `/accounts/${account}/workers/dispatch/namespaces/${encoded}`
                  : kind === 'hyperdrive'
                    ? `/accounts/${account}/hyperdrive/configs/${encoded}`
                    : kind === 'worker'
                      ? `/accounts/${account}/workers/scripts/${encoded}`
                      : kind === 'zone'
                        ? `/zones/${encoded}`
                        : null;
    if (!path) {
      throw new Error(`platform: Unsupported Cloudflare deletion kind ${kind}.`);
    }
    try {
      await this.request(path, { method: 'DELETE' });
    } catch (error) {
      if (error instanceof PlatformCloudflareApiError && error.status === 404) {
        return;
      }
      throw error;
    }
  }

  async removeRoutes(
    accountId: string,
    zoneId: string,
    workerNames: ReadonlySet<string>,
  ): Promise<void> {
    const routes = await this.request<ReadonlyArray<{ id?: unknown; script?: unknown }>>(
      `/zones/${encodeURIComponent(zoneId)}/workers/routes`,
    );
    for (const route of routes) {
      if (
        typeof route.id === 'string' &&
        typeof route.script === 'string' &&
        workerNames.has(route.script)
      ) {
        await this.request(
          `/zones/${encodeURIComponent(zoneId)}/workers/routes/${encodeURIComponent(route.id)}`,
          {
            method: 'DELETE',
          },
        );
      }
    }
    const domains = await this.request<ReadonlyArray<{ id?: unknown; service?: unknown }>>(
      `/accounts/${encodeURIComponent(accountId)}/workers/domains/records`,
    );
    for (const domain of domains) {
      if (
        typeof domain.id === 'string' &&
        typeof domain.service === 'string' &&
        workerNames.has(domain.service)
      ) {
        await this.request(
          `/accounts/${encodeURIComponent(accountId)}/workers/domains/records/${encodeURIComponent(domain.id)}`,
          { method: 'DELETE' },
        );
      }
    }
  }

  async setWorkerSubdomain(accountId: string, workerName: string, enabled: boolean): Promise<void> {
    await this.request(
      `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/subdomain`,
      {
        body: JSON.stringify({ enabled, previews_enabled: enabled }),
        headers: { 'Cloudflare-Workers-Script-Api-Date': '2025-08-01' },
        method: 'POST',
      },
    );
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`platform: ${label} is missing from the Cloudflare response.`);
  }
  return value;
}

function parseZone(value: Record<string, unknown>): CloudflareZone {
  return {
    id: requiredString(value.id, 'Zone id'),
    name: requiredString(value.name, 'Zone name'),
    nameServers: Array.isArray(value.name_servers)
      ? value.name_servers.filter((entry): entry is string => typeof entry === 'string')
      : [],
    status: requiredString(value.status, 'Zone status'),
  };
}

function parseDnsRecord(value: Record<string, unknown>): CloudflareDnsRecord {
  return {
    content: requiredString(value.content, 'DNS record content'),
    id: requiredString(value.id, 'DNS record id'),
    name: requiredString(value.name, 'DNS record name'),
    proxied: value.proxied === true,
    type: requiredString(value.type, 'DNS record type'),
  };
}

export function parsePostgresConnectionString(value: string): {
  database: string;
  host: string;
  password: string;
  port: number;
  user: string;
} {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('platform: DATABASE_URL must be a PostgreSQL connection string.');
  }
  if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || !url.hostname) {
    throw new Error('platform: DATABASE_URL must use postgres:// or postgresql://.');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!url.username || !url.password || !database) {
    throw new Error('platform: DATABASE_URL must include username, password, host, and database.');
  }
  return {
    database,
    host: url.hostname,
    password: decodeURIComponent(url.password),
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username),
  };
}
