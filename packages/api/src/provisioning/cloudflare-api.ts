const CF_API_BASE = "https://api.cloudflare.com/client/v4/accounts";
const CF_ZONE_API_BASE = "https://api.cloudflare.com/client/v4/zones";

interface CfApiResult<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
}

async function cfFetch<T>(url: string, apiToken: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const json = (await response.json()) as CfApiResult<T>;
  if (!json.success) {
    const msg = json.errors.map((e) => e.message).join(", ");
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
    method: "POST",
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
    method: "POST",
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
    method: "POST",
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
  if (result.length === 0) throw new Error(`D1 database not found: ${name}`);
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
  if (result.length === 0) throw new Error(`KV namespace not found: ${title}`);
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
  if (result.length === 0) throw new Error(`Queue not found: ${name}`);
  return result[0];
}

export async function deleteD1Database(
  accountId: string,
  apiToken: string,
  databaseId: string,
): Promise<void> {
  await cfFetch(`${CF_API_BASE}/${accountId}/d1/database/${databaseId}`, apiToken, {
    method: "DELETE",
  });
}

export async function deleteKVNamespace(
  accountId: string,
  apiToken: string,
  namespaceId: string,
): Promise<void> {
  await cfFetch(`${CF_API_BASE}/${accountId}/storage/kv/namespaces/${namespaceId}`, apiToken, {
    method: "DELETE",
  });
}

export async function deleteR2Bucket(
  accountId: string,
  apiToken: string,
  bucketName: string,
): Promise<void> {
  await cfFetch(`${CF_API_BASE}/${accountId}/r2/buckets/${bucketName}`, apiToken, {
    method: "DELETE",
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
    method: "POST",
    body: JSON.stringify({ queue_name: name }),
  });
}

export async function addQueueConsumer(
  accountId: string,
  apiToken: string,
  queueId: string,
  scriptName: string,
  settings?: { max_batch_size?: number; max_batch_timeout?: number },
): Promise<void> {
  await cfFetch(`${CF_API_BASE}/${accountId}/queues/${queueId}/consumers`, apiToken, {
    method: "POST",
    body: JSON.stringify({
      script_name: scriptName,
      type: "worker",
      ...(settings && { settings }),
    }),
  });
}

export async function deleteQueue(
  accountId: string,
  apiToken: string,
  queueId: string,
): Promise<void> {
  await cfFetch(`${CF_API_BASE}/${accountId}/queues/${queueId}`, apiToken, {
    method: "DELETE",
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
    method: "POST",
    body: JSON.stringify({ hostname, ssl: { method: "http", type: "dv" } }),
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
    method: "DELETE",
  });
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
      method: "POST",
      body: JSON.stringify({ files: batch }),
    });
  }
}
