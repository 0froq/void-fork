import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { signJwt } from "../../src/auth/jwt";

const SCHEMA_PATH = fileURLToPath(new URL("../../migrations/0001_initial.sql", import.meta.url));

export const JWT_SECRET = "test-jwt-secret";
export const CF_API_TOKEN = "test-cf-token";
export const CF_ACCOUNT_ID = "test-account-id";

export type TestEnv = {
  DB: D1Database;
  ASSETS: R2Bucket;
  ROUTING: KVNamespace;
  DISPATCH: DispatchNamespace;
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  JWT_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
};

let mf: Miniflare;

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

  // Apply schema — split into individual statements for Miniflare D1
  const schema = readFileSync(SCHEMA_PATH, "utf-8");
  const stmts = schema
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  await db.batch(stmts.map((s) => db.prepare(s)));

  return {
    DB: db,
    ASSETS: r2 as unknown as R2Bucket,
    ROUTING: kv as unknown as KVNamespace,
    DISPATCH: {} as DispatchNamespace,
    CF_API_TOKEN,
    CF_ACCOUNT_ID,
    JWT_SECRET,
    GITHUB_CLIENT_ID: "test-github-client-id",
    GITHUB_CLIENT_SECRET: "test-github-client-secret",
  };
}

export async function teardownEnv(): Promise<void> {
  await mf.dispose();
}

export async function clearTables(db: D1Database): Promise<void> {
  await db.batch([
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
  githubId?: number,
): Promise<{ id: string; login: string; jwt: string }> {
  const id = `user_test${++userCounter}`;
  const gid = githubId ?? 10000 + userCounter;
  await db
    .prepare("INSERT INTO users (id, github_id, github_login, email) VALUES (?, ?, ?, ?)")
    .bind(id, gid, login, null)
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
  queryD1: (url: string, init?: RequestInit) => Response | Promise<Response>;
  uploadWorker: (url: string, init?: RequestInit) => Response | Promise<Response>;
}

const defaultMocks: CfApiMocks = {
  createD1: () => cfSuccess({ uuid: "d1-test-uuid", name: "test-db" }),
  createKV: () => cfSuccess({ id: "kv-test-id", title: "test-kv" }),
  createR2: () => cfSuccess({ name: "test-bucket" }),
  queryD1: () => cfSuccess([{ results: [] }]),
  uploadWorker: () => new Response("ok", { status: 200 }),
};

export function mockCfApi(overrides: Partial<CfApiMocks> = {}): ReturnType<typeof vi.fn> {
  const mocks = { ...defaultMocks, ...overrides };

  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";

    // Order matters: more specific patterns first
    if (method === "PUT" && url.includes("/workers/dispatch/")) {
      return mocks.uploadWorker(url, init);
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
