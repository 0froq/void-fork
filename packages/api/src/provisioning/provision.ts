import { eq } from 'drizzle-orm';
import { hmacSignState } from '../auth/hmac';
import { getProjectResources, createResource, type Db } from '../db';
import { getProjectQueueName } from '../naming';
import { resources as resourcesTable } from '../schema';
import type { DeployManifest, Resource } from '../types';
import {
  createD1Database,
  createKVNamespace,
  createR2Bucket,
  createQueue,
  getD1DatabaseByName,
  getKVNamespaceByTitle,
  getQueueByName,
} from './cloudflare-api';

export interface WorkerBinding {
  type: 'd1' | 'kv_namespace' | 'r2_bucket' | 'queue' | 'service' | 'plain_text' | 'hyperdrive';
  name: string;
  id?: string;
  namespace_id?: string;
  bucket_name?: string;
  queue_name?: string;
  queue_id?: string;
  service?: string;
  text?: string;
}

export async function provisionBindings(
  db: Db,
  accountId: string,
  apiToken: string,
  projectId: string,
  manifest: DeployManifest,
  jwtSecret: string,
  aiProxyService: string,
): Promise<Array<WorkerBinding>> {
  const existing = await getProjectResources(db, projectId);

  // Run all CF API provisioning calls in parallel
  const tasks: Array<Promise<WorkerBinding>> = [];

  for (const name of manifest.bindings.d1 ?? []) {
    tasks.push(
      ensureResource(db, accountId, apiToken, projectId, 'd1', name, existing).then(
        (r): WorkerBinding => ({ type: 'd1', name, id: r.cf_id }),
      ),
    );
  }

  for (const name of manifest.bindings.kv ?? []) {
    tasks.push(
      ensureResource(db, accountId, apiToken, projectId, 'kv', name, existing).then(
        (r): WorkerBinding => ({ type: 'kv_namespace', name, namespace_id: r.cf_id }),
      ),
    );
  }

  for (const name of manifest.bindings.r2 ?? []) {
    tasks.push(
      ensureResource(db, accountId, apiToken, projectId, 'r2', name, existing).then(
        (r): WorkerBinding => ({ type: 'r2_bucket', name, bucket_name: r.cf_id }),
      ),
    );
  }

  for (const q of manifest.queues ?? []) {
    const queueName = getProjectQueueName(projectId, q.name);
    tasks.push(
      ensureResource(db, accountId, apiToken, projectId, 'queue', q.name, existing).then(
        (r): WorkerBinding => ({
          type: 'queue',
          name: q.bindingName,
          queue_name: queueName,
          queue_id: r.cf_id,
        }),
      ),
    );
  }

  for (const name of manifest.bindings.hyperdrive ?? []) {
    const found = existing.find((r) => r.type === 'hyperdrive' && r.binding_name === name);
    if (!found) {
      throw new Error(
        `Hyperdrive not provisioned for binding "${name}". Run \`void db set-url\` first.`,
      );
    }
    tasks.push(Promise.resolve({ type: 'hyperdrive' as const, name, id: found.cf_id }));
  }

  const bindings = await Promise.all(tasks);

  // Always inject proxy bindings — used by AI, revalidation, and future platform features.
  // The AI-specific usage limit check stays in the proxy (/ai/* middleware).
  const proxyToken = await hmacSignState(projectId, jwtSecret);
  bindings.push({ type: 'service', name: '__VOID_PROXY', service: aiProxyService });
  bindings.push({ type: 'plain_text', name: '__PROJECT_ID', text: projectId });
  bindings.push({ type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: proxyToken });

  return bindings;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ensureResource(
  db: Db,
  accountId: string,
  apiToken: string,
  projectId: string,
  type: Resource['type'],
  bindingName: string,
  existing: Array<Resource>,
): Promise<Resource> {
  // Normalize: R2 bucket names only allow lowercase alphanumeric + hyphens
  const resourceName = `${projectId}-${bindingName}`.toLowerCase().replaceAll('_', '-');

  const found = existing.find((r) => r.type === type && r.binding_name === bindingName);
  if (found) {
    // Fix legacy queue resources that stored queue_name instead of queue_id (UUID)
    if (type === 'queue' && !UUID_RE.test(found.cf_id)) {
      const queueInfo = await getQueueByName(accountId, apiToken, resourceName);
      await db
        .update(resourcesTable)
        .set({ cf_id: queueInfo.queue_id })
        .where(eq(resourcesTable.id, found.id));
      found.cf_id = queueInfo.queue_id;
    }
    return found;
  }
  let cfId: string;

  try {
    cfId = await createCfResource(type, accountId, apiToken, resourceName);
  } catch (err) {
    if (isAlreadyExistsError(err)) {
      cfId = await lookupCfResource(type, accountId, apiToken, resourceName);
    } else {
      throw err;
    }
  }

  return createResource(db, projectId, type, cfId, bindingName);
}

async function createCfResource(
  type: Resource['type'],
  accountId: string,
  apiToken: string,
  resourceName: string,
): Promise<string> {
  switch (type) {
    case 'd1': {
      const result = await createD1Database(accountId, apiToken, resourceName);
      return result.uuid;
    }
    case 'kv': {
      const result = await createKVNamespace(accountId, apiToken, resourceName);
      return result.id;
    }
    case 'r2': {
      const result = await createR2Bucket(accountId, apiToken, resourceName);
      return result.name;
    }
    case 'queue': {
      const result = await createQueue(accountId, apiToken, resourceName);
      return result.queue_id;
    }
    case 'hyperdrive':
      throw new Error(
        'Hyperdrive resources are provisioned via the database endpoint, not ensureResource',
      );
    case 'container':
      throw new Error('Container resources are provisioned during sandbox deployment');
  }
}

async function lookupCfResource(
  type: Resource['type'],
  accountId: string,
  apiToken: string,
  resourceName: string,
): Promise<string> {
  switch (type) {
    case 'd1': {
      const result = await getD1DatabaseByName(accountId, apiToken, resourceName);
      return result.uuid;
    }
    case 'kv': {
      const result = await getKVNamespaceByTitle(accountId, apiToken, resourceName);
      return result.id;
    }
    case 'r2':
      // R2 bucket name IS the cf_id — no lookup API needed
      return resourceName;
    case 'queue': {
      const result = await getQueueByName(accountId, apiToken, resourceName);
      return result.queue_id;
    }
    case 'hyperdrive':
      throw new Error(
        'Hyperdrive resources are provisioned via the database endpoint, not ensureResource',
      );
    case 'container':
      throw new Error('Container resources are provisioned during sandbox deployment');
  }
}

function isAlreadyExistsError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const msg = err.message.toLowerCase();
  return msg.includes('already exists') || msg.includes('already been created');
}
