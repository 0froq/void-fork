export const CF_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';
const CF_ZONE_API_BASE = 'https://api.cloudflare.com/client/v4/zones';

type CfApiResult<T> = {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
};

/**
 * Error thrown by `cfFetch` when the Cloudflare API returns a non-success
 * envelope. Exposes the HTTP `status` so callers can branch on the wire-level
 * code (e.g. treat 409 as a concurrent-create race) rather than relying on
 * fragile message matching. The `.message` format is preserved verbatim
 * (`Cloudflare API error: <joined messages>`) so existing string-based
 * detection keeps working as a defense-in-depth fallback.
 */
export class CloudflareApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'CloudflareApiError';
    this.status = status;
  }
}

export async function cfFetch<T>(url: string, apiToken: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  const json = (await response.json()) as CfApiResult<T>;
  if (!json.success) {
    const msg = json.errors.map((e) => e.message).join(', ');
    throw new CloudflareApiError(`Cloudflare API error: ${msg}`, response.status);
  }
  return json.result;
}

export type D1DatabaseInfo = {
  uuid: string;
  name: string;
};

export async function createD1Database(
  accountId: string,
  apiToken: string,
  name: string,
): Promise<D1DatabaseInfo> {
  return cfFetch<D1DatabaseInfo>(`${CF_API_BASE}/${accountId}/d1/database`, apiToken, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export type KVNamespaceInfo = {
  id: string;
  title: string;
};

export async function createKVNamespace(
  accountId: string,
  apiToken: string,
  title: string,
): Promise<KVNamespaceInfo> {
  return cfFetch<KVNamespaceInfo>(`${CF_API_BASE}/${accountId}/storage/kv/namespaces`, apiToken, {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
}

export type R2BucketInfo = {
  name: string;
};

export async function createR2Bucket(
  accountId: string,
  apiToken: string,
  name: string,
): Promise<R2BucketInfo> {
  return cfFetch<R2BucketInfo>(`${CF_API_BASE}/${accountId}/r2/buckets`, apiToken, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function getD1DatabaseByName(
  accountId: string,
  apiToken: string,
  name: string,
): Promise<D1DatabaseInfo> {
  const result = await cfFetch<Array<D1DatabaseInfo>>(
    `${CF_API_BASE}/${accountId}/d1/database?name=${encodeURIComponent(name)}`,
    apiToken,
  );
  if (result.length === 0) {
    throw new Error(`D1 database not found: ${name}`);
  }
  return result[0];
}

export async function getKVNamespaceByTitle(
  accountId: string,
  apiToken: string,
  title: string,
): Promise<KVNamespaceInfo> {
  const result = await cfFetch<Array<KVNamespaceInfo>>(
    `${CF_API_BASE}/${accountId}/storage/kv/namespaces?title=${encodeURIComponent(title)}`,
    apiToken,
  );
  if (result.length === 0) {
    throw new Error(`KV namespace not found: ${title}`);
  }
  return result[0];
}

export async function getQueueByName(
  accountId: string,
  apiToken: string,
  name: string,
): Promise<QueueInfo> {
  const result = await cfFetch<Array<QueueInfo>>(
    `${CF_API_BASE}/${accountId}/queues?name=${encodeURIComponent(name)}`,
    apiToken,
  );
  if (result.length === 0) {
    throw new Error(`Queue not found: ${name}`);
  }
  return result[0];
}

export async function deleteD1Database(
  accountId: string,
  apiToken: string,
  databaseId: string,
): Promise<void> {
  await cfFetch(`${CF_API_BASE}/${accountId}/d1/database/${databaseId}`, apiToken, {
    method: 'DELETE',
  });
}

export async function deleteKVNamespace(
  accountId: string,
  apiToken: string,
  namespaceId: string,
): Promise<void> {
  await cfFetch(`${CF_API_BASE}/${accountId}/storage/kv/namespaces/${namespaceId}`, apiToken, {
    method: 'DELETE',
  });
}

export async function deleteR2Bucket(
  accountId: string,
  apiToken: string,
  bucketName: string,
): Promise<void> {
  await cfFetch(`${CF_API_BASE}/${accountId}/r2/buckets/${bucketName}`, apiToken, {
    method: 'DELETE',
  });
}

// --- Queues ---

export type QueueInfo = {
  queue_id: string;
  queue_name: string;
};

export async function createQueue(
  accountId: string,
  apiToken: string,
  name: string,
): Promise<QueueInfo> {
  return cfFetch<QueueInfo>(`${CF_API_BASE}/${accountId}/queues`, apiToken, {
    method: 'POST',
    body: JSON.stringify({ queue_name: name }),
  });
}

type QueueConsumerSettings = {
  batch_size?: number;
  max_wait_time_ms?: number;
  max_retries?: number;
  retry_delay?: number;
};

type QueueConsumerInfo = {
  consumer_id: string;
  // CF Queues API asymmetry: POST/PUT bodies use `script_name`, but
  // GET /queues/{id}/consumers returns the subscribed worker under
  // `script`. Using `script_name` for reads returns `undefined` for
  // every consumer, so a legitimate same-script re-deploy falls
  // through to the "different owner" branch and reports
  // `ownerScript: 'unknown'` — which the post-ba41cef conflict path
  // then treats as a fatal deploy failure on every subsequent deploy.
  script: string;
  type: string;
  settings: QueueConsumerSettings;
};

/**
 * Result of a queue consumer upsert. `created` = a new consumer was
 * registered. `updated` = our script already owned the consumer (settings
 * may have been PUT). `conflict` = a different script owns the consumer;
 * caller must decide whether to fail or surface a warning. Queue names are
 * derived from projectId so the conflict path is only reachable when a
 * rogue consumer was registered out-of-band.
 */
export type AddQueueConsumerResult =
  | { status: 'created' }
  | { status: 'updated' }
  | { status: 'conflict'; ownerScript: string };

/**
 * Create or update a queue consumer. POST creates on first deploy; on
 * subsequent deploys the POST fails with "already exists" and we PUT
 * to update settings instead.
 */
export async function addQueueConsumer(
  accountId: string,
  apiToken: string,
  queueId: string,
  scriptName: string,
  settings?: QueueConsumerSettings,
): Promise<AddQueueConsumerResult> {
  const consumersUrl = `${CF_API_BASE}/${accountId}/queues/${queueId}/consumers`;
  const consumerBody = {
    script_name: scriptName,
    type: 'worker',
    ...(settings && { settings }),
  };

  // Fast path: try to create the consumer directly
  try {
    await cfFetch(consumersUrl, apiToken, {
      method: 'POST',
      body: JSON.stringify(consumerBody),
    });
    return { status: 'created' };
  } catch (err) {
    if (
      !(err instanceof Error) ||
      (!err.message.toLowerCase().includes('already exists') &&
        !err.message.toLowerCase().includes('already has a consumer'))
    ) {
      throw err;
    }
  }

  // Consumer exists — find ours and update settings
  const consumers = await cfFetch<Array<QueueConsumerInfo>>(consumersUrl, apiToken);
  const ours = consumers.find((c) => c.script === scriptName);

  if (!ours) {
    // A different script owns this consumer. Surface the owner so the
    // caller can emit a deploy warning; do not throw — the deploy should
    // still complete so other queues in the same manifest can succeed.
    const ownerScript = consumers[0]?.script ?? 'unknown';
    return { status: 'conflict', ownerScript };
  }

  if (settings) {
    await cfFetch(`${consumersUrl}/${ours.consumer_id}`, apiToken, {
      method: 'PUT',
      body: JSON.stringify(consumerBody),
    });
  }
  return { status: 'updated' };
}

export async function deleteQueue(
  accountId: string,
  apiToken: string,
  queueId: string,
): Promise<void> {
  await cfFetch(`${CF_API_BASE}/${accountId}/queues/${queueId}`, apiToken, {
    method: 'DELETE',
  });
}

type DispatchWorkerBinding = {
  type: string;
  name: string;
  text?: string;
};

export type ProxyTokenLookup =
  | { kind: 'found'; token: string }
  | { kind: 'missing' }
  | { kind: 'error'; error: Error };

/**
 * Read the `__VOID_PROXY_TOKEN` plain-text binding that was baked into a
 * user worker at deploy time. Used on rollback/backfill so we hand
 * dispatch the EXACT token the target worker expects, rather than
 * re-deriving from the current `JWT_SECRET` — which would 401 if the
 * secret had rotated since that deployment was live.
 *
 * Returns a typed result so callers can distinguish:
 *   - `found`: use the baked token as-is.
 *   - `missing`: bindings list returned but no `__VOID_PROXY_TOKEN` —
 *     a legacy worker. Callers may fall back to re-derivation with a
 *     visible warning.
 *   - `error`: CF API failure (rate limit, transport, auth, 5xx).
 *     Callers MUST NOT fall back silently — a transient error must
 *     not end up writing a mismatched token that 401s after a
 *     `JWT_SECRET` rotation.
 */
export async function getDispatchWorkerProxyToken(
  accountId: string,
  apiToken: string,
  dispatchNamespace: string,
  scriptName: string,
): Promise<ProxyTokenLookup> {
  const url = `${CF_API_BASE}/${accountId}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${scriptName}/bindings`;
  let bindings: Array<DispatchWorkerBinding>;
  try {
    bindings = await cfFetch<Array<DispatchWorkerBinding>>(url, apiToken);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return { kind: 'error', error };
  }
  const token = bindings.find(
    (b) => b.type === 'plain_text' && b.name === '__VOID_PROXY_TOKEN',
  )?.text;
  if (!token) {
    return { kind: 'missing' };
  }
  return { kind: 'found', token };
}

// --- Custom Hostnames (CF for SaaS) ---

export type CustomHostnameInfo = {
  id: string;
  hostname: string;
  status: string;
  ssl: { status: string };
  verification_errors?: Array<string>;
};

export async function createCustomHostname(
  zoneId: string,
  apiToken: string,
  hostname: string,
): Promise<CustomHostnameInfo> {
  return cfFetch<CustomHostnameInfo>(`${CF_ZONE_API_BASE}/${zoneId}/custom_hostnames`, apiToken, {
    method: 'POST',
    body: JSON.stringify({ hostname, ssl: { method: 'http', type: 'dv' } }),
  });
}

export async function getCustomHostname(
  zoneId: string,
  apiToken: string,
  hostnameId: string,
): Promise<CustomHostnameInfo> {
  return cfFetch<CustomHostnameInfo>(
    `${CF_ZONE_API_BASE}/${zoneId}/custom_hostnames/${hostnameId}`,
    apiToken,
  );
}

export async function deleteCustomHostname(
  zoneId: string,
  apiToken: string,
  hostnameId: string,
): Promise<void> {
  await cfFetch(`${CF_ZONE_API_BASE}/${zoneId}/custom_hostnames/${hostnameId}`, apiToken, {
    method: 'DELETE',
  });
}

// --- Hyperdrive ---

export type HyperdriveInfo = {
  id: string;
  name: string;
};

export async function createHyperdrive(
  accountId: string,
  apiToken: string,
  name: string,
  connectionString: string,
): Promise<HyperdriveInfo> {
  return cfFetch<HyperdriveInfo>(`${CF_API_BASE}/${accountId}/hyperdrive/configs`, apiToken, {
    method: 'POST',
    body: JSON.stringify({ name, origin: { connection_string: connectionString } }),
  });
}

export async function updateHyperdrive(
  accountId: string,
  apiToken: string,
  hyperdriveId: string,
  connectionString: string,
): Promise<HyperdriveInfo> {
  return cfFetch<HyperdriveInfo>(
    `${CF_API_BASE}/${accountId}/hyperdrive/configs/${hyperdriveId}`,
    apiToken,
    {
      method: 'PUT',
      body: JSON.stringify({ origin: { connection_string: connectionString } }),
    },
  );
}

export async function deleteHyperdrive(
  accountId: string,
  apiToken: string,
  hyperdriveId: string,
): Promise<void> {
  await cfFetch(`${CF_API_BASE}/${accountId}/hyperdrive/configs/${hyperdriveId}`, apiToken, {
    method: 'DELETE',
  });
}

export async function getHyperdriveByName(
  accountId: string,
  apiToken: string,
  name: string,
): Promise<HyperdriveInfo> {
  const result = await cfFetch<Array<HyperdriveInfo>>(
    `${CF_API_BASE}/${accountId}/hyperdrive/configs`,
    apiToken,
  );
  const match = result.find((h) => h.name === name);
  if (!match) {
    throw new Error(`Hyperdrive config not found: ${name}`);
  }
  return match;
}

// --- Cache Purge ---

export async function purgeZoneCache(
  zoneId: string,
  apiToken: string,
  files: Array<string>,
): Promise<void> {
  // CF API allows max 100 URLs per purge request (Free/Pro/Business)
  for (let i = 0; i < files.length; i += 100) {
    const batch = files.slice(i, i + 100);
    await cfFetch(`${CF_ZONE_API_BASE}/${zoneId}/purge_cache`, apiToken, {
      method: 'POST',
      body: JSON.stringify({ files: batch }),
    });
  }
}
