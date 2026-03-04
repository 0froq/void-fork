import { Miniflare } from "miniflare";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import pg from "pg";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import type { Db } from "../../src/db";
import * as schema from "../../src/schema";
import { users, projects, deployments, resources, domains } from "../../src/schema";
import { signJwt } from "../../src/auth/jwt";
import type { PlanId } from "../../src/tiers";
import { setTestDb, clearTestDb } from "./setup";

export const JWT_SECRET = "test-jwt-secret";
export const CF_API_TOKEN = "test-cf-token";
export const CF_ACCOUNT_ID = "test-account-id";
export const CF_ZONE_ID = "test-zone-id";

export type TestEnv = {
  db: Db;
  HYPERDRIVE: { connectionString: string };
  ISR_CACHE: KVNamespace;
  ROUTING: KVNamespace;
  DISPATCH: DispatchNamespace;
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CF_ZONE_ID: string;
  JWT_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  DEV_AUTH_BYPASS?: string;
  SITE_DOMAIN?: string;
  USAGE_COUNTER: DurableObjectNamespace;
  CRON_SCHEDULER: DurableObjectNamespace;
};

function createMockDoNamespace(): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ toString: () => name }),
    get: (_id: unknown) => ({
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        if (url.pathname === "/rollover") return Response.json({ rolled: false });
        if (url.pathname === "/init") return Response.json({ ok: true });
        if (url.pathname === "/state") return Response.json({});
        return Response.json({ totalRequests: 0, suspended: false });
      },
    }),
  } as unknown as DurableObjectNamespace;
}

let mf: Miniflare;
let pglite: PGlite | undefined;
let pgPool: pg.Pool | undefined;

export async function setupEnv(): Promise<TestEnv> {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(''); } }",
    kvNamespaces: ["ROUTING", "ISR_CACHE"],
  });

  const kv = await mf.getKVNamespace("ROUTING");
  const isrCache = await mf.getKVNamespace("ISR_CACHE");

  const databaseUrl = process.env.DATABASE_URL;
  let db: Db;
  if (databaseUrl) {
    pgPool = new pg.Pool({ connectionString: databaseUrl });
    db = drizzlePg(pgPool, { schema }) as unknown as Db;
  } else {
    pglite = new PGlite();
    db = drizzle(pglite, { schema }) as unknown as Db;
    await migrate(drizzle(pglite, { schema }), {
      migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
    });
  }

  // Register the test db so the vi.mock in setup.ts routes createDb() here
  setTestDb(db);

  return {
    db,
    HYPERDRIVE: { connectionString: "test://mock" },
    ISR_CACHE: isrCache as unknown as KVNamespace,
    ROUTING: kv as unknown as KVNamespace,
    DISPATCH: {} as DispatchNamespace,
    CF_API_TOKEN,
    CF_ACCOUNT_ID,
    CF_ZONE_ID,
    JWT_SECRET,
    GITHUB_CLIENT_ID: "test-github-client-id",
    GITHUB_CLIENT_SECRET: "test-github-client-secret",
    GOOGLE_CLIENT_ID: "test-google-client-id",
    GOOGLE_CLIENT_SECRET: "test-google-client-secret",
    USAGE_COUNTER: createMockDoNamespace(),
    CRON_SCHEDULER: createMockDoNamespace(),
  };
}

export async function teardownEnv(): Promise<void> {
  clearTestDb();
  await mf.dispose();
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
  await db.delete(deployments);
  await db.delete(projects);
  await db.delete(users);
}

let userCounter = 0;

export async function createTestUser(
  db: Db,
  login = "testuser",
  provider = "github",
  providerId?: string,
  plan: PlanId = "free",
  role: "user" | "admin" = "user",
): Promise<{ id: string; login: string; jwt: string }> {
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
  const jwt = await signJwt({ sub: id, login }, JWT_SECRET);
  return { id, login, jwt };
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
  status: "pending" | "live" | "failed" = "live",
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
  return { id };
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
  setWorkerSecret: (url: string, init?: RequestInit) => Response | Promise<Response>;
  deleteWorkerSecret: (url: string, init?: RequestInit) => Response | Promise<Response>;
  createCustomHostname: (url: string, init?: RequestInit) => Response | Promise<Response>;
  getCustomHostname: (url: string, init?: RequestInit) => Response | Promise<Response>;
  deleteCustomHostname: (url: string, init?: RequestInit) => Response | Promise<Response>;
  purgeCache: (url: string, init?: RequestInit) => Response | Promise<Response>;
  analyticsQuery: (url: string, init?: RequestInit) => Response | Promise<Response>;
}

const defaultMocks: CfApiMocks = {
  createD1: () => cfSuccess({ uuid: "d1-test-uuid", name: "test-db" }),
  createKV: () => cfSuccess({ id: "kv-test-id", title: "test-kv" }),
  createR2: () => cfSuccess({ name: "test-bucket" }),
  createQueue: () =>
    cfSuccess({ queue_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", queue_name: "test-queue" }),
  addQueueConsumer: () => cfSuccess({}),
  deleteD1: () => cfSuccess(null),
  deleteKV: () => cfSuccess(null),
  deleteR2: () => cfSuccess(null),
  deleteQueue: () => cfSuccess(null),
  deleteWorker: () => new Response("ok", { status: 200 }),
  queryD1: () => cfSuccess([{ results: [] }]),
  uploadWorker: () => new Response("ok", { status: 200 }),
  assetUploadSession: () => cfSuccess({ jwt: "test-asset-jwt", buckets: [["hash1"]] }),
  assetUpload: () => cfSuccess({ jwt: "test-completion-jwt" }),
  setWorkerSecret: () => cfSuccess({}),
  deleteWorkerSecret: () => cfSuccess({}),
  createCustomHostname: () =>
    cfSuccess({
      id: "ch-test-id",
      hostname: "test.example.com",
      status: "pending",
      ssl: { status: "pending" },
    }),
  getCustomHostname: () =>
    cfSuccess({
      id: "ch-test-id",
      hostname: "test.example.com",
      status: "pending",
      ssl: { status: "pending" },
    }),
  deleteCustomHostname: () => cfSuccess(null),
  purgeCache: () => cfSuccess({ id: "purge-test-id" }),
  analyticsQuery: () => Response.json({ data: [{ requests: 0, bandwidth_bytes: 0 }] }),
};

export function mockCfApi(overrides: Partial<CfApiMocks> = {}): ReturnType<typeof vi.fn> {
  const mocks = { ...defaultMocks, ...overrides };

  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";

    // Order matters: more specific patterns first
    if (method === "POST" && url.includes("/purge_cache")) {
      return mocks.purgeCache(url, init);
    }
    if (method === "POST" && url.includes("/custom_hostnames")) {
      return mocks.createCustomHostname(url, init);
    }
    if (method === "GET" && url.includes("/custom_hostnames/")) {
      return mocks.getCustomHostname(url, init);
    }
    if (method === "DELETE" && url.includes("/custom_hostnames/")) {
      return mocks.deleteCustomHostname(url, init);
    }
    if (method === "POST" && url.includes("/analytics_engine/sql")) {
      return mocks.analyticsQuery(url, init);
    }
    if (method === "POST" && url.includes("/assets-upload-session")) {
      return mocks.assetUploadSession(url, init);
    }
    if (method === "POST" && url.includes("/workers/assets/upload")) {
      return mocks.assetUpload(url, init);
    }
    if (method === "PUT" && url.includes("/workers/dispatch/") && url.includes("/secrets")) {
      return mocks.setWorkerSecret(url, init);
    }
    if (method === "DELETE" && url.includes("/workers/dispatch/") && url.includes("/secrets/")) {
      return mocks.deleteWorkerSecret(url, init);
    }
    if (method === "DELETE" && url.includes("/workers/dispatch/")) {
      return mocks.deleteWorker(url, init);
    }
    if (method === "PUT" && url.includes("/workers/dispatch/")) {
      return mocks.uploadWorker(url, init);
    }
    if (method === "DELETE" && url.includes("/d1/database/")) {
      return mocks.deleteD1(url, init);
    }
    if (method === "DELETE" && url.includes("/storage/kv/namespaces/")) {
      return mocks.deleteKV(url, init);
    }
    if (method === "DELETE" && url.includes("/r2/buckets/")) {
      return mocks.deleteR2(url, init);
    }
    if (method === "POST" && url.includes("/d1/database/") && url.includes("/query")) {
      return mocks.queryD1(url, init);
    }
    if (method === "POST" && url.includes("/d1/database")) {
      return mocks.createD1(url, init);
    }
    if (method === "POST" && url.includes("/storage/kv/namespaces")) {
      return mocks.createKV(url, init);
    }
    if (method === "POST" && url.includes("/r2/buckets")) {
      return mocks.createR2(url, init);
    }
    if (method === "POST" && url.includes("/queues/") && url.includes("/consumers")) {
      return mocks.addQueueConsumer(url, init);
    }
    if (method === "POST" && url.includes("/queues")) {
      return mocks.createQueue(url, init);
    }
    if (method === "DELETE" && url.includes("/queues/")) {
      return mocks.deleteQueue(url, init);
    }

    throw new Error(`Unmocked fetch: ${method} ${url}`);
  });

  vi.stubGlobal("fetch", fn);
  return fn;
}

export async function readAllEvents(res: Response): Promise<unknown[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}
