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

// --- Workers Observability ---

export interface ObservabilityLogEntry {
  timestamp: number;
  level: string;
  message: string;
  outcome: string;
  scriptName: string;
  request?: { url: string; method: string };
  response?: { status: number };
  exception?: { name: string; message: string };
  cpuTimeMs?: number;
  wallTimeMs?: number;
}

export interface ObservabilityQueryResult {
  data: ObservabilityLogEntry[];
}

export async function queryWorkerLogs(
  accountId: string,
  apiToken: string,
  scriptName: string,
  options: {
    sinceMs: number;
    untilMs?: number;
    level?: string;
    outcome?: string;
    limit?: number;
  },
): Promise<ObservabilityQueryResult> {
  const filters: Record<string, unknown>[] = [
    { key: "$workers.scriptName", operation: "eq", value: scriptName, type: "string" },
  ];
  if (options.level && options.level !== "all") {
    filters.push({
      key: "$workers.event.log.level",
      operation: "eq",
      value: options.level,
      type: "string",
    });
  }
  if (options.outcome && options.outcome !== "all") {
    filters.push({
      key: "$workers.outcome",
      operation: "eq",
      value: options.outcome,
      type: "string",
    });
  }

  // CF Observability API uses unix timestamps (seconds) and a query.parameters structure
  const fromSec = Math.floor(options.sinceMs / 1000);
  const toSec = Math.floor((options.untilMs ?? Date.now()) / 1000);

  const body = {
    timeframe: { from: fromSec, to: toSec },
    query: {
      parameters: {
        datasets: ["workers:events"],
        filters,
        filterCombination: "and",
        limit: options.limit ?? 100,
        orderBy: { value: "timestamp", order: "desc" },
      },
    },
  };

  const response = await fetch(
    `${CF_API_BASE}/${accountId}/workers/observability/telemetry/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Observability query failed (${response.status}): ${text}`);
  }

  const json = (await response.json()) as { result?: { data?: unknown[]; run?: unknown } };
  const rawData = json.result?.data ?? [];

  // Normalize CF response into our log entry format
  const data: ObservabilityLogEntry[] = rawData.map((entry: any) => ({
    timestamp: entry.$workers?.eventTimestamp ?? entry.timestamp ?? 0,
    level: entry.$workers?.event?.log?.level ?? entry.$metadata?.level ?? "log",
    message: entry.$metadata?.message ?? entry.$workers?.event?.log?.message?.join(" ") ?? "",
    outcome: entry.$workers?.outcome ?? "unknown",
    scriptName: entry.$workers?.scriptName ?? scriptName,
    ...(entry.$workers?.event?.request && {
      request: {
        url: entry.$workers.event.request.url,
        method: entry.$workers.event.request.method,
      },
    }),
    ...(entry.$workers?.event?.response && {
      response: { status: entry.$workers.event.response.status },
    }),
    ...(entry.$workers?.exceptions?.[0] && {
      exception: {
        name: entry.$workers.exceptions[0].name,
        message: entry.$workers.exceptions[0].message,
      },
    }),
    cpuTimeMs: entry.$workers?.cpuTimeMs,
    wallTimeMs: entry.$workers?.wallTimeMs,
  }));

  return { data };
}

// --- Tail API ---

export interface TailSession {
  id: string;
  url: string;
  expires_at: string;
}

export async function createTailSession(
  accountId: string,
  apiToken: string,
  dispatchNamespace: string,
  scriptName: string,
): Promise<TailSession> {
  return cfFetch<TailSession>(
    `${CF_API_BASE}/${accountId}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${scriptName}/tails`,
    apiToken,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function deleteTailSession(
  accountId: string,
  apiToken: string,
  dispatchNamespace: string,
  scriptName: string,
  tailId: string,
): Promise<void> {
  await cfFetch(
    `${CF_API_BASE}/${accountId}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${scriptName}/tails/${tailId}`,
    apiToken,
    { method: "DELETE" },
  );
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
