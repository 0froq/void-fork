import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signJwt } from "@vite-cloud/platform/auth/jwt";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../platform/migrations/", import.meta.url));

export const JWT_SECRET = "test-jwt-secret";

export type TestEnv = {
  DB: D1Database;
  ROUTING: KVNamespace;
  JWT_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
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
  });

  const db = await mf.getD1Database("DB");
  const kv = await mf.getKVNamespace("ROUTING");

  // Apply all migrations sequentially
  for (let i = 1; i <= 8; i++) {
    const file = `${MIGRATIONS_DIR}${String(i).padStart(4, "0")}_${getMigrationName(i)}.sql`;
    const sql = readFileSync(file, "utf-8");
    for (const stmt of splitStatements(sql)) {
      await db.prepare(stmt).run();
    }
  }

  return {
    DB: db,
    ROUTING: kv as unknown as KVNamespace,
    JWT_SECRET,
    GITHUB_CLIENT_ID: "test-github-client-id",
    GITHUB_CLIENT_SECRET: "test-github-client-secret",
    GOOGLE_CLIENT_ID: "test-google-client-id",
    GOOGLE_CLIENT_SECRET: "test-google-client-secret",
  };
}

function getMigrationName(n: number): string {
  const names: Record<number, string> = {
    1: "initial",
    2: "provider_auth",
    3: "project_mode",
    4: "deployment_source",
    5: "domains",
    6: "usage_tiers",
    7: "billing_cycle",
    8: "user_roles",
  };
  return names[n]!;
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
  role: "user" | "admin" = "user",
): Promise<{ id: string; login: string; jwt: string }> {
  const id = `user_test${++userCounter}`;
  await db
    .prepare(
      "INSERT INTO users (id, provider, provider_id, login, email, plan, role, github_id, github_login) VALUES (?, ?, ?, ?, ?, ?, ?, ABS(RANDOM()), ?)",
    )
    .bind(id, "github", String(10000 + userCounter), login, null, "free", role, login)
    .run();
  const jwt = await signJwt({ sub: id, login }, JWT_SECRET);
  return { id, login, jwt };
}

let projectCounter = 0;

export async function createTestProject(
  db: D1Database,
  userId: string,
  slug?: string,
): Promise<{ id: string; slug: string }> {
  const n = ++projectCounter;
  const s = slug ?? `test-project-${n}`;
  const id = `proj_test${n}`;
  await db
    .prepare("INSERT INTO projects (id, user_id, slug, name) VALUES (?, ?, ?, ?)")
    .bind(id, userId, s, `Test Project ${n}`)
    .run();
  return { id, slug: s };
}
