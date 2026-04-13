import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle } from 'drizzle-orm/pglite';
import pg from 'pg';
import { vi } from 'vitest';
import { signJwt } from '../../src/auth/jwt';
import type { Db } from '../../src/db';
import { generateId } from '../../src/id';
import { encryptProjectSecret } from '../../src/project-secrets';
import * as schema from '../../src/schema';
import {
  users,
  oauthAccounts,
  projects,
  deployments,
  projectSecrets,
  resources,
  domains,
  invitations,
  oauthNonces,
} from '../../src/schema';
import type { PlanId } from '../../src/tiers';
import { loadPGliteTemplateBundle } from './db-template';
import { setTestDb, clearTestDb } from './setup';

export const JWT_SECRET = 'test-jwt-secret';
export const CF_API_TOKEN = 'test-cf-token';
export const CF_ACCOUNT_ID = 'test-account-id';
export const CF_ZONE_ID = 'test-zone-id';
export const PROJECT_SECRET_ACTIVE_KEY_VERSION = '1';
export const PROJECT_SECRET_KEYS_JSON = JSON.stringify({
  [PROJECT_SECRET_ACTIVE_KEY_VERSION]: Buffer.from('0123456789abcdef0123456789abcdef').toString(
    'base64',
  ),
});

export type TestEnv = {
  db: Db;
  HYPERDRIVE: { connectionString: string };
  ISR_CACHE: KVNamespace;
  ROUTING: KVNamespace;
  STATIC_ASSETS: KVNamespace;
  STATIC_ASSETS_R2: R2Bucket;
  DISPATCH: DispatchNamespace;
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CF_ZONE_ID: string;
  JWT_SECRET: string;
  PROJECT_SECRET_KEYS_JSON: string;
  PROJECT_SECRET_ACTIVE_KEY_VERSION: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_PREVIEW_REPO_PAT?: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  DEV_AUTH_BYPASS?: string;
  SITE_DOMAIN?: string;
  USAGE_COUNTER: DurableObjectNamespace;
  CRON_SCHEDULER: DurableObjectNamespace;
  ERROR_ALERT_MONITOR: DurableObjectNamespace;
};

export function createMockExecutionContext(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

function createMockDoNamespace(): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ toString: () => name }),
    get: (_id: unknown) => ({
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        if (url.pathname === '/rollover') {
          return Response.json({ rolled: false });
        }
        if (url.pathname === '/init') {
          return Response.json({ ok: true });
        }
        if (url.pathname === '/state') {
          return Response.json({});
        }
        return Response.json({ totalRequests: 0, suspended: false });
      },
    }),
  } as unknown as DurableObjectNamespace;
}

type StoredValue = {
  value: string | ArrayBuffer;
  metadata?: unknown;
};

function toArrayBuffer(value: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (value instanceof ArrayBuffer) {
    return value.slice(0);
  }

  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer;
}

class MemoryKVNamespace {
  private readonly store = new Map<string, StoredValue>();

  async get(
    key: string,
    type?: 'text' | 'json' | 'arrayBuffer' | 'stream',
  ): Promise<string | ArrayBuffer | ReadableStream | unknown | null> {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }

    if (type === 'arrayBuffer') {
      return entry.value instanceof ArrayBuffer
        ? entry.value.slice(0)
        : toArrayBuffer(new TextEncoder().encode(entry.value));
    }

    const text =
      typeof entry.value === 'string'
        ? entry.value
        : new TextDecoder().decode(new Uint8Array(entry.value));

    if (type === 'json') {
      return JSON.parse(text);
    }

    if (type === 'stream') {
      return new Blob([typeof entry.value === 'string' ? entry.value : entry.value]).stream();
    }

    return text;
  }

  async getWithMetadata<T>(
    key: string,
    type?: 'text' | 'json' | 'arrayBuffer' | 'stream',
  ): Promise<{
    value: string | ArrayBuffer | ReadableStream | unknown | null;
    metadata: T | null;
  }> {
    const entry = this.store.get(key);
    return {
      value: await this.get(key, type),
      metadata: (entry?.metadata as T | undefined) ?? null,
    };
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView,
    options?: { metadata?: unknown },
  ): Promise<void> {
    const normalized = typeof value === 'string' ? value : toArrayBuffer(value);

    this.store.set(key, {
      value: normalized,
      metadata: options?.metadata === undefined ? undefined : structuredClone(options.metadata),
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: {
    prefix?: string;
    cursor?: string;
  }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor: string }> {
    const prefix = options?.prefix ?? '';
    const offset = options?.cursor ? Number(options.cursor) : 0;
    const keys = Array.from(this.store.keys())
      .filter((key) => key.startsWith(prefix))
      .sort()
      .slice(offset)
      .map((name) => ({ name }));

    return {
      keys,
      list_complete: true,
      cursor: '',
    };
  }
}

class MemoryR2Bucket {
  private readonly store = new Map<string, { body: ArrayBuffer; httpMetadata?: unknown }>();

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: { httpMetadata?: unknown },
  ): Promise<void> {
    const body =
      typeof value === 'string'
        ? toArrayBuffer(new TextEncoder().encode(value))
        : toArrayBuffer(value);
    this.store.set(key, { body, httpMetadata: options?.httpMetadata });
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      this.store.delete(key);
    }
  }
}

let pglite: PGlite | undefined;
let pgPool: pg.Pool | undefined;

export async function setupEnv(): Promise<TestEnv> {
  const kv = new MemoryKVNamespace();
  const isrCache = new MemoryKVNamespace();
  const staticAssets = new MemoryKVNamespace();
  const staticAssetsR2 = new MemoryR2Bucket();

  const databaseUrl = process.env.VOID_TEST_DATABASE_URL;
  let db: Db;
  if (databaseUrl) {
    pgPool = new pg.Pool({ connectionString: databaseUrl });
    db = drizzlePg(pgPool, { schema }) as unknown as Db;
  } else {
    pglite = new PGlite({
      loadDataDir: await loadPGliteTemplateBundle(),
      relaxedDurability: true,
    });
    db = drizzle(pglite, { schema }) as unknown as Db;
  }

  // Register the test db so the vi.mock in setup.ts routes createDb() here
  setTestDb(db);

  return {
    db,
    HYPERDRIVE: { connectionString: 'test://mock' },
    ISR_CACHE: isrCache as unknown as KVNamespace,
    ROUTING: kv as unknown as KVNamespace,
    STATIC_ASSETS: staticAssets as unknown as KVNamespace,
    STATIC_ASSETS_R2: staticAssetsR2 as unknown as R2Bucket,
    DISPATCH: {} as DispatchNamespace,
    CF_API_TOKEN,
    CF_ACCOUNT_ID,
    CF_ZONE_ID,
    JWT_SECRET,
    PROJECT_SECRET_KEYS_JSON,
    PROJECT_SECRET_ACTIVE_KEY_VERSION,
    GITHUB_CLIENT_ID: 'test-github-client-id',
    GITHUB_CLIENT_SECRET: 'test-github-client-secret',
    GOOGLE_CLIENT_ID: 'test-google-client-id',
    GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
    USAGE_COUNTER: createMockDoNamespace(),
    CRON_SCHEDULER: createMockDoNamespace(),
    ERROR_ALERT_MONITOR: createMockDoNamespace(),
  };
}

export async function teardownEnv(): Promise<void> {
  clearTestDb();
  if (pgPool) {
    await pgPool.end();
    pgPool = undefined;
  }
  if (pglite) {
    await pglite.close();
    pglite = undefined;
  }
}

export async function clearTables(db: Db): Promise<void> {
  await db.delete(domains);
  await db.delete(resources);
  await db.delete(projectSecrets);
  await db.delete(deployments);
  await db.delete(projects);
  await db.delete(invitations);
  await db.delete(oauthAccounts);
  await db.delete(users);
  await db.delete(oauthNonces);
}

export async function seedOAuthNonce(db: Db, nonce: string): Promise<void> {
  await db.insert(oauthNonces).values({ nonce, expires_at: sql`now() + interval '600 seconds'` });
}

let userCounter = 0;

export async function createTestUser(
  db: Db,
  login = 'testuser',
  provider = 'github',
  providerId?: string,
  plan: PlanId = 'free',
  role: 'user' | 'admin' = 'user',
): Promise<{ id: string; login: string; jwt: string; adminJwt: string }> {
  const id = `user_test${++userCounter}`;
  const pid = providerId ?? String(10000 + userCounter);
  await db.insert(users).values({
    id,
    provider,
    provider_id: pid,
    login,
    email: null,
    plan,
    role,
  });
  await db.insert(oauthAccounts).values({
    id: generateId('oa'),
    user_id: id,
    provider,
    provider_id: pid,
  });
  const jwt = await signJwt({ sub: id, login, aud: 'api' }, JWT_SECRET);
  const adminJwt = await signJwt({ sub: id, login, aud: 'admin' }, JWT_SECRET);
  return { id, login, jwt, adminJwt };
}

let projectCounter = 0;

export async function createTestProject(
  db: Db,
  userId: string,
  slug?: string,
): Promise<{ id: string; slug: string }> {
  const n = ++projectCounter;
  const s = slug ?? `test-project-${n}`;
  const id = `proj_test${n}`;
  await db.insert(projects).values({ id, user_id: userId, slug: s });
  return { id, slug: s };
}

let deploymentCounter = 0;

export async function createTestDeployment(
  db: Db,
  projectId: string,
  status:
    | 'pending'
    | 'uploading'
    | 'migrating'
    | 'prerendering'
    | 'canceling'
    | 'live'
    | 'failed'
    | 'canceled' = 'live',
  source?: string,
  errorMessage?: string,
): Promise<{ id: string }> {
  const n = ++deploymentCounter;
  const id = `dpl_test${n}`;
  await db.insert(deployments).values({
    id,
    project_id: projectId,
    status,
    source: source ?? null,
    error_message: errorMessage ?? null,
  });
  if (status === 'live') {
    await db.update(projects).set({ active_deployment_id: id }).where(eq(projects.id, projectId));
  }
  return { id };
}

export async function createTestProjectSecret(
  db: Db,
  env: Pick<TestEnv, 'PROJECT_SECRET_KEYS_JSON' | 'PROJECT_SECRET_ACTIVE_KEY_VERSION'>,
  projectId: string,
  name: string,
  value: string,
  managedReason: string | null = null,
): Promise<void> {
  const encrypted = await encryptProjectSecret(env, projectId, name, value);
  await db
    .insert(projectSecrets)
    .values({
      id: generateId('psc'),
      project_id: projectId,
      name,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      key_version: encrypted.keyVersion,
      managed_reason: managedReason,
    })
    .onConflictDoUpdate({
      target: [projectSecrets.project_id, projectSecrets.name],
      set: {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        key_version: encrypted.keyVersion,
        managed_reason: managedReason,
        updated_at: sql`now()`,
      },
    });
}

// --- Fetch mocking ---

export function cfSuccess(result: unknown): Response {
  return Response.json({ success: true, errors: [], result });
}

export function cfError(message: string, status = 400): Response {
  return Response.json({ success: false, errors: [{ code: 1000, message }] }, { status });
}

export interface CfApiMocks {
  createD1: (url: string, init?: RequestInit) => Response;
  createKV: (url: string, init?: RequestInit) => Response;
  createR2: (url: string, init?: RequestInit) => Response;
  createQueue: (url: string, init?: RequestInit) => Response;
  addQueueConsumer: (url: string, init?: RequestInit) => Response;
  deleteD1: (url: string, init?: RequestInit) => Response;
  deleteKV: (url: string, init?: RequestInit) => Response;
  deleteR2: (url: string, init?: RequestInit) => Response;
  deleteQueue: (url: string, init?: RequestInit) => Response;
  deleteWorker: (url: string, init?: RequestInit) => Response;
  queryD1: (url: string, init?: RequestInit) => Response | Promise<Response>;
  uploadWorker: (url: string, init?: RequestInit) => Response | Promise<Response>;
  assetUploadSession: (url: string, init?: RequestInit) => Response | Promise<Response>;
  assetUpload: (url: string, init?: RequestInit) => Response | Promise<Response>;
  listWorkerSecrets: (url: string, init?: RequestInit) => Response | Promise<Response>;
  setWorkerSecret: (url: string, init?: RequestInit) => Response | Promise<Response>;
  deleteWorkerSecret: (url: string, init?: RequestInit) => Response | Promise<Response>;
  createCustomHostname: (url: string, init?: RequestInit) => Response | Promise<Response>;
  getCustomHostname: (url: string, init?: RequestInit) => Response | Promise<Response>;
  deleteCustomHostname: (url: string, init?: RequestInit) => Response | Promise<Response>;
  purgeCache: (url: string, init?: RequestInit) => Response | Promise<Response>;
  analyticsQuery: (url: string, init?: RequestInit) => Response | Promise<Response>;
}

const defaultMocks: CfApiMocks = {
  createD1: () => cfSuccess({ uuid: 'd1-test-uuid', name: 'test-db' }),
  createKV: () => cfSuccess({ id: 'kv-test-id', title: 'test-kv' }),
  createR2: () => cfSuccess({ name: 'test-bucket' }),
  createQueue: () =>
    cfSuccess({ queue_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', queue_name: 'test-queue' }),
  addQueueConsumer: () => cfSuccess({}),
  deleteD1: () => cfSuccess(null),
  deleteKV: () => cfSuccess(null),
  deleteR2: () => cfSuccess(null),
  deleteQueue: () => cfSuccess(null),
  deleteWorker: () => new Response('ok', { status: 200 }),
  queryD1: () => cfSuccess([{ results: [] }]),
  uploadWorker: () => new Response('ok', { status: 200 }),
  assetUploadSession: async (_url: string, init?: RequestInit) => {
    // Extract real hashes from the manifest in the request body so the mock
    // bucket matches what collectAssets actually computed (BLAKE3 hashes).
    try {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      if (body?.manifest) {
        const hashes = [...new Set(Object.values(body.manifest).map((e: any) => e.hash))];
        return cfSuccess({ jwt: 'test-asset-jwt', buckets: [hashes] });
      }
    } catch {
      // fall through to default
    }
    return cfSuccess({ jwt: 'test-asset-jwt', buckets: [['hash1']] });
  },
  assetUpload: () => cfSuccess({ jwt: 'test-completion-jwt' }),
  listWorkerSecrets: () => cfSuccess([]),
  setWorkerSecret: () => cfSuccess({}),
  deleteWorkerSecret: () => cfSuccess({}),
  createCustomHostname: () =>
    cfSuccess({
      id: 'ch-test-id',
      hostname: 'test.example.com',
      status: 'pending',
      ssl: { status: 'pending' },
    }),
  getCustomHostname: () =>
    cfSuccess({
      id: 'ch-test-id',
      hostname: 'test.example.com',
      status: 'pending',
      ssl: { status: 'pending' },
    }),
  deleteCustomHostname: () => cfSuccess(null),
  purgeCache: () => cfSuccess({ id: 'purge-test-id' }),
  analyticsQuery: () => Response.json({ data: [{ requests: 0, bandwidth_bytes: 0 }] }),
};

export function mockCfApi(overrides: Partial<CfApiMocks> = {}): ReturnType<typeof vi.fn> {
  const mocks = { ...defaultMocks, ...overrides };

  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';

    // Order matters: more specific patterns first
    if (method === 'POST' && url.includes('/purge_cache')) {
      return mocks.purgeCache(url, init);
    }
    if (method === 'POST' && url.includes('/custom_hostnames')) {
      return mocks.createCustomHostname(url, init);
    }
    if (method === 'GET' && url.includes('/custom_hostnames/')) {
      return mocks.getCustomHostname(url, init);
    }
    if (method === 'DELETE' && url.includes('/custom_hostnames/')) {
      return mocks.deleteCustomHostname(url, init);
    }
    if (method === 'POST' && url.includes('/analytics_engine/sql')) {
      return mocks.analyticsQuery(url, init);
    }
    if (method === 'POST' && url.includes('/assets-upload-session')) {
      return mocks.assetUploadSession(url, init);
    }
    if (method === 'POST' && url.includes('/workers/assets/upload')) {
      return mocks.assetUpload(url, init);
    }
    if (method === 'GET' && url.includes('/workers/dispatch/') && url.includes('/secrets')) {
      return mocks.listWorkerSecrets(url, init);
    }
    if (method === 'PUT' && url.includes('/workers/dispatch/') && url.includes('/secrets')) {
      return mocks.setWorkerSecret(url, init);
    }
    if (method === 'DELETE' && url.includes('/workers/dispatch/') && url.includes('/secrets/')) {
      return mocks.deleteWorkerSecret(url, init);
    }
    if (method === 'DELETE' && url.includes('/workers/dispatch/')) {
      return mocks.deleteWorker(url, init);
    }
    if (method === 'PUT' && url.includes('/workers/dispatch/')) {
      return mocks.uploadWorker(url, init);
    }
    if (method === 'DELETE' && url.includes('/d1/database/')) {
      return mocks.deleteD1(url, init);
    }
    if (method === 'DELETE' && url.includes('/storage/kv/namespaces/')) {
      return mocks.deleteKV(url, init);
    }
    if (method === 'DELETE' && url.includes('/r2/buckets/')) {
      return mocks.deleteR2(url, init);
    }
    if (method === 'POST' && url.includes('/d1/database/') && url.includes('/query')) {
      return mocks.queryD1(url, init);
    }
    if (method === 'POST' && url.includes('/d1/database')) {
      return mocks.createD1(url, init);
    }
    if (method === 'POST' && url.includes('/storage/kv/namespaces')) {
      return mocks.createKV(url, init);
    }
    if (method === 'POST' && url.includes('/r2/buckets')) {
      return mocks.createR2(url, init);
    }
    if (method === 'POST' && url.includes('/queues/') && url.includes('/consumers')) {
      return mocks.addQueueConsumer(url, init);
    }
    if (method === 'POST' && url.includes('/queues')) {
      return mocks.createQueue(url, init);
    }
    if (method === 'DELETE' && url.includes('/queues/')) {
      return mocks.deleteQueue(url, init);
    }

    throw new Error(`Unmocked fetch: ${method} ${url}`);
  });

  vi.stubGlobal('fetch', fn);
  return fn;
}

export async function readAllEvents(res: Response): Promise<unknown[]> {
  const text = await res.text();
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}
