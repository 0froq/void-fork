import type { DeployManifest, Resource } from "../types";
import { getProjectResources, createResource } from "../db";
import { createD1Database, createKVNamespace, createR2Bucket } from "./cloudflare-api";

export interface WorkerBinding {
  type: "d1" | "kv_namespace" | "r2_bucket";
  name: string;
  id?: string;
  namespace_id?: string;
  bucket_name?: string;
}

export async function provisionBindings(
  db: D1Database,
  accountId: string,
  apiToken: string,
  projectId: string,
  manifest: DeployManifest,
): Promise<WorkerBinding[]> {
  const existing = await getProjectResources(db, projectId);
  const bindings: WorkerBinding[] = [];

  // D1 databases
  for (const name of manifest.bindings.d1 ?? []) {
    const binding = await ensureResource(db, accountId, apiToken, projectId, "d1", name, existing);
    bindings.push({ type: "d1", name, id: binding.cf_id });
  }

  // KV namespaces
  for (const name of manifest.bindings.kv ?? []) {
    const binding = await ensureResource(db, accountId, apiToken, projectId, "kv", name, existing);
    bindings.push({ type: "kv_namespace", name, namespace_id: binding.cf_id });
  }

  // R2 buckets
  for (const name of manifest.bindings.r2 ?? []) {
    const binding = await ensureResource(db, accountId, apiToken, projectId, "r2", name, existing);
    bindings.push({ type: "r2_bucket", name, bucket_name: binding.cf_id });
  }

  return bindings;
}

async function ensureResource(
  db: D1Database,
  accountId: string,
  apiToken: string,
  projectId: string,
  type: Resource["type"],
  bindingName: string,
  existing: Resource[],
): Promise<Resource> {
  const found = existing.find((r) => r.type === type && r.binding_name === bindingName);
  if (found) return found;

  const resourceName = `${projectId}-${bindingName}`;
  let cfId: string;

  switch (type) {
    case "d1": {
      const result = await createD1Database(accountId, apiToken, resourceName);
      cfId = result.uuid;
      break;
    }
    case "kv": {
      const result = await createKVNamespace(accountId, apiToken, resourceName);
      cfId = result.id;
      break;
    }
    case "r2": {
      const result = await createR2Bucket(accountId, apiToken, resourceName);
      cfId = result.name;
      break;
    }
  }

  return createResource(db, projectId, type, cfId, bindingName);
}
