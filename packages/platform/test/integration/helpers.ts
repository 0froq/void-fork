import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { signJwt } from "../../src/auth/jwt";

const MIGRATION_0001 = fileURLToPath(new URL("../../migrations/0001_initial.sql", import.meta.url));
const MIGRATION_0002 = fileURLToPath(
  new URL("../../migrations/0002_provider_auth.sql", import.meta.url),
);
const MIGRATION_0003 = fileURLToPath(
  new URL("../../migrations/0003_project_mode.sql", import.meta.url),
);
const MIGRATION_0004 = fileURLToPath(
  new URL("../../migrations/0004_deployment_source.sql", import.meta.url),
);
const MIGRATION_0005 = fileURLToPath(new URL("../../migrations/0005_domains.sql", import.meta.url));
const MIGRATION_0006 = fileURLToPath(
  new URL("../../migrations/0006_usage_tiers.sql", import.meta.url),
);
const MIGRATION_0007 = fileURLToPath(
  new URL("../../migrations/0007_billing_cycle.sql", import.meta.url),
);
const MIGRATION_0008 = fileURLToPath(
  new URL("../../migrations/0008_user_roles.sql", import.meta.url),
);
const MIGRATION_0009 = fileURLToPath(
  new URL("../../migrations/0009_deployment_errors.sql", import.meta.url),
);

export const JWT_SECRET = "test-jwt-secret";
export const CF_API_TOKEN = "test-cf-token";
export const CF_ACCOUNT_ID = "test-account-id";
export const CF_ZONE_ID = "test-zone-id";

export type TestEnv = {
  DB: D1Database;
  ASSETS: R2Bucket;
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
  SIGNUP_ALLOWLIST?: string;
};

let mf: Miniflare;

function splitStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function setupEnv(): Promise<TestEnv> {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(''); } }",
    d1Databases: ["DB"],
    kvNamespaces: ["ROUTING"],
    r2Buckets: ["ASSETS"],
  });

  const db = await mf.getD1Database("DB");
  const kv = await mf.getKVNamespace("ROUTING");
  const r2 = await mf.getR2Bucket("ASSETS");

  // Apply migrations sequentially
  const schema1 = readFileSync(MIGRATION_0001, "utf-8");
  await db.batch(splitStatements(schema1).map((s) => db.prepare(s)));

  const schema2 = readFileSync(MIGRATION_0002, "utf-8");
  for (const stmt of splitStatements(schema2)) {
    await db.prepare(stmt).run();
  }

  const schema3 = readFileSync(MIGRATION_0003, "utf-8");
  for (const stmt of splitStatements(schema3)) {
    await db.prepare(stmt).run();
  }

  const schema4 = readFileSync(MIGRATION_0004, "utf-8");
  for (const stmt of splitStatements(schema4)) {
    await db.prepare(stmt).run();
  }

  const schema5 = readFileSync(MIGRATION_0005, "utf-8");
  for (const stmt of splitStatements(schema5)) {
    await db.prepare(stmt).run();
  }

  const schema6 = readFileSync(MIGRATION_0006, "utf-8");
  for (const stmt of splitStatements(schema6)) {
    await db.prepare(stmt).run();
  }

  const schema7 = readFileSync(MIGRATION_0007, "utf-8");
  for (const stmt of splitStatements(schema7)) {
    await db.prepare(stmt).run();
  }

  const schema8 = readFileSync(MIGRATION_0008, "utf-8");
  for (const stmt of splitStatements(schema8)) {
    await db.prepare(stmt).run();
  }

  const schema9 = readFileSync(MIGRATION_0009, "utf-8");
  for (const stmt of splitStatements(schema9)) {
    await db.prepare(stmt).run();
  }

  return {
    DB: db,
    ASSETS: r2 as unknown as R2Bucket,
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
  };
}

export async function teardownEnv(): Promise<void> {
  await mf.dispose();
}

export async function clearTables(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM domains"),
    db.prepare("DELETE FROM resources"),
    db.prepare("DELETE FROM deployments"),
    db.prepare("DELETE FROM projects"),
    db.prepare("DELETE FROM users"),
  ]);
}

let userCounter = 0;

export async function createTestUser(
  db: D1Database,
  login = "testuser",
  provider = "github",
  providerId?: string,
  plan = "free",
  role: "user" | "admin" = "user",
): Promise<{ id: string; login: string; jwt: string }> {
  const id = `user_test${++userCounter}`;
  const pid = providerId ?? String(10000 + userCounter);
  await db
    .prepare(
      "INSERT INTO users (id, provider, provider_id, login, email, plan, role, github_id, github_login) VALUES (?, ?, ?, ?, ?, ?, ?, ABS(RANDOM()), ?)",
    )
    .bind(id, provider, pid, login, null, plan, role, login)
    .run();
  const jwt = await signJwt({ sub: id, login }, JWT_SECRET);
  return { id, login, jwt };
}

let projectCounter = 0;

export async function createTestProject(
  db: D1Database,
  userId: string,
  slug?: string,
  name?: string,
): Promise<{ id: string; slug: string }> {
  const n = ++projectCounter;
  const s = slug ?? `test-project-${n}`;
  const id = `proj_test${n}`;
  await db
    .prepare("INSERT INTO projects (id, user_id, slug, name) VALUES (?, ?, ?, ?)")
    .bind(id, userId, s, name ?? `Test Project ${n}`)
    .run();
  return { id, slug: s };
}

let deploymentCounter = 0;

export async function createTestDeployment(
  db: D1Database,
  projectId: string,
  status: "pending" | "live" | "failed" = "live",
  source?: string,
  errorMessage?: string,
): Promise<{ id: string }> {
  const n = ++deploymentCounter;
  const id = `dpl_test${n}`;
  await db
    .prepare(
      "INSERT INTO deployments (id, project_id, status, source, error_message) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id, projectId, status, source ?? null, errorMessage ?? null)
    .run();
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
  deleteD1: (url: string, init?: RequestInit) => Response;
  deleteKV: (url: string, init?: RequestInit) => Response;
  deleteR2: (url: string, init?: RequestInit) => Response;
  deleteWorker: (url: string, init?: RequestInit) => Response;
  queryD1: (url: string, init?: RequestInit) => Response | Promise<Response>;
  uploadWorker: (url: string, init?: RequestInit) => Response | Promise<Response>;
  setWorkerSecret: (url: string, init?: RequestInit) => Response | Promise<Response>;
  deleteWorkerSecret: (url: string, init?: RequestInit) => Response | Promise<Response>;
  createCustomHostname: (url: string, init?: RequestInit) => Response | Promise<Response>;
  getCustomHostname: (url: string, init?: RequestInit) => Response | Promise<Response>;
  deleteCustomHostname: (url: string, init?: RequestInit) => Response | Promise<Response>;
}

const defaultMocks: CfApiMocks = {
  createD1: () => cfSuccess({ uuid: "d1-test-uuid", name: "test-db" }),
  createKV: () => cfSuccess({ id: "kv-test-id", title: "test-kv" }),
  createR2: () => cfSuccess({ name: "test-bucket" }),
  deleteD1: () => cfSuccess(null),
  deleteKV: () => cfSuccess(null),
  deleteR2: () => cfSuccess(null),
  deleteWorker: () => new Response("ok", { status: 200 }),
  queryD1: () => cfSuccess([{ results: [] }]),
  uploadWorker: () => new Response("ok", { status: 200 }),
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
};

export function mockCfApi(overrides: Partial<CfApiMocks> = {}): ReturnType<typeof vi.fn> {
  const mocks = { ...defaultMocks, ...overrides };

  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";

    // Order matters: more specific patterns first
    if (method === "POST" && url.includes("/custom_hostnames")) {
      return mocks.createCustomHostname(url, init);
    }
    if (method === "GET" && url.includes("/custom_hostnames/")) {
      return mocks.getCustomHostname(url, init);
    }
    if (method === "DELETE" && url.includes("/custom_hostnames/")) {
      return mocks.deleteCustomHostname(url, init);
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

    throw new Error(`Unmocked fetch: ${method} ${url}`);
  });

  vi.stubGlobal("fetch", fn);
  return fn;
}
