export const CF_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';
const CF_ZONE_API_BASE = 'https://api.cloudflare.com/client/v4/zones';

interface CfApiResult<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
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
    throw new Error(`Cloudflare API error: ${msg}`);
  }
  return json.result;
}

export interface D1DatabaseInfo {
  uuid: string;
  name: string;
}

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

export interface KVNamespaceInfo {
  id: string;
  title: string;
}

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

export interface R2BucketInfo {
  name: string;
}

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
  const result = await cfFetch<D1DatabaseInfo[]>(
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
  const result = await cfFetch<KVNamespaceInfo[]>(
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
  const result = await cfFetch<QueueInfo[]>(
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

export interface QueueInfo {
  queue_id: string;
  queue_name: string;
}

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

interface QueueConsumerSettings {
  batch_size?: number;
  max_wait_time_ms?: number;
  max_retries?: number;
  retry_delay?: number;
}

interface QueueConsumerInfo {
  consumer_id: string;
  script_name: string;
  type: string;
  settings: QueueConsumerSettings;
}

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
): Promise<void> {
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
    return;
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
  const consumers = await cfFetch<QueueConsumerInfo[]>(consumersUrl, apiToken);
  const ours = consumers.find((c) => c.script_name === scriptName);

  if (!ours) {
    // A different script owns this consumer — log and continue.
    // Queue names are derived from projectId so this is effectively
    // unreachable, but if it happens the deploy should not fail.
    console.warn(
      `[queue] consumer for "${scriptName}" not found on queue ${queueId} — a different script may own it`,
    );
    return;
  }

  if (settings) {
    await cfFetch(`${consumersUrl}/${ours.consumer_id}`, apiToken, {
      method: 'PUT',
      body: JSON.stringify(consumerBody),
    });
  }
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

// --- Custom Hostnames (CF for SaaS) ---

export interface CustomHostnameInfo {
  id: string;
  hostname: string;
  status: string;
  ssl: { status: string };
  verification_errors?: string[];
}

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

export interface HyperdriveInfo {
  id: string;
  name: string;
}

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
  const result = await cfFetch<HyperdriveInfo[]>(
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
  files: string[],
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
