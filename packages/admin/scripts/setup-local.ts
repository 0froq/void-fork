import { execSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import * as p from "@clack/prompts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminDir = resolve(__dirname, "..");
const platformDir = resolve(__dirname, "../../platform");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: "pipe" });
}

function d1ExecuteFile(cwd: string, statements: string[]): void {
  const sql = statements.join(";\n") + ";\n";
  const tmpFile = resolve(tmpdir(), `vite-cloud-seed-${Date.now()}.sql`);
  writeFileSync(tmpFile, sql, "utf-8");
  try {
    run(`npx wrangler d1 execute vite-cloud-platform --local --file "${tmpFile}"`, cwd);
  } finally {
    unlinkSync(tmpFile);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  p.intro("Admin local dev setup");

  // 1. Reset local D1 state
  const s = p.spinner();

  s.start("Resetting local D1 state");
  for (const dir of [platformDir, adminDir]) {
    const state = resolve(dir, ".wrangler/state");
    if (existsSync(state)) {
      rmSync(state, { recursive: true });
    }
  }
  s.stop("Reset local D1 state");

  // 3. Apply migrations
  s.start("Applying migrations (platform)");
  run("npx wrangler d1 migrations apply vite-cloud-platform --local", platformDir);
  s.stop("Applied migrations (platform)");

  s.start("Applying migrations (admin)");
  run("npx wrangler d1 migrations apply vite-cloud-platform --local", adminDir);
  s.stop("Applied migrations (admin)");

  // 4. Seed fake data
  s.start("Seeding fake data");

  const stmts: string[] = [];

  // -- Staggered dates (spread over past 3 months) --------------------------
  const daysAgo = (d: number) => {
    const dt = new Date(Date.now() - d * 86400000);
    return dt.toISOString().replace("T", " ").slice(0, 19);
  };
  const now = daysAgo(0);
  const ago7 = daysAgo(7);
  const ago30 = daysAgo(30);
  const ago60 = daysAgo(60);
  const ago90 = daysAgo(90);

  // -- Users -----------------------------------------------------------------
  const users = [
    {
      id: "user_seed1",
      provider: "github",
      provider_id: "100001",
      login: "alice",
      email: "alice@example.com",
      plan: "free",
      billing_cycle_start: ago30,
      created_at: ago90,
    },
    {
      id: "user_seed2",
      provider: "github",
      provider_id: "100002",
      login: "bob",
      email: "bob@example.com",
      plan: "solo",
      billing_cycle_start: ago7,
      created_at: ago60,
    },
    {
      id: "user_seed3",
      provider: "google",
      provider_id: "100003",
      login: "carol",
      email: "carol@example.com",
      plan: "pro",
      billing_cycle_start: ago60,
      created_at: ago60,
    },
    {
      id: "user_seed4",
      provider: "github",
      provider_id: "100004",
      login: "dave",
      email: "dave@example.com",
      plan: "sponsored",
      billing_cycle_start: ago90,
      created_at: ago90,
    },
    {
      id: "user_seed5",
      provider: "google",
      provider_id: "100005",
      login: "eve",
      email: "eve@example.com",
      plan: "free",
      billing_cycle_start: ago30,
      suspended_reason: "usage_limit_exceeded",
      created_at: ago30,
    },
  ];

  for (const u of users) {
    stmts.push(
      `INSERT INTO users (id, provider, provider_id, login, email, github_id, github_login, plan, billing_cycle_start, suspended_reason, role, created_at) VALUES ('${u.id}', '${u.provider}', '${u.provider_id}', '${u.login}', '${u.email}', ${u.provider_id}, '${u.login}', '${u.plan}', '${u.billing_cycle_start}', ${u.suspended_reason ? `'${u.suspended_reason}'` : "NULL"}, 'user', '${u.created_at}')`,
    );
  }

  // -- Projects (varied modes) -----------------------------------------------
  const projects = [
    { id: "proj_seed1", user_id: "user_seed1", slug: "my-app", name: "my-app", mode: "fullstack" },
    { id: "proj_seed2", user_id: "user_seed1", slug: "docs-site", name: "docs-site", mode: "ssg" },
    {
      id: "proj_seed3",
      user_id: "user_seed2",
      slug: "api-service",
      name: "api-service",
      mode: "fullstack",
    },
    {
      id: "proj_seed4",
      user_id: "user_seed2",
      slug: "landing-page",
      name: "landing-page",
      mode: "spa",
    },
    {
      id: "proj_seed5",
      user_id: "user_seed3",
      slug: "dashboard",
      name: "dashboard",
      mode: "framework",
    },
    { id: "proj_seed6", user_id: "user_seed4", slug: "blog", name: "blog", mode: "ssg" },
  ];

  for (const proj of projects) {
    stmts.push(
      `INSERT INTO projects (id, user_id, slug, name, mode, created_at) VALUES ('${proj.id}', '${proj.user_id}', '${proj.slug}', '${proj.name}', '${proj.mode}', '${ago60}')`,
    );
  }

  // -- Manifests (JSON strings) -----------------------------------------------
  const manifests = {
    dpl_seed1: JSON.stringify({
      bindings: { d1: ["DB"], kv: ["CACHE"] },
      migrations: [{ name: "001_create_users.sql", destructive: false }],
    }),
    dpl_seed4: JSON.stringify({
      bindings: { d1: ["DB"], r2: ["UPLOADS"] },
      migrations: [
        { name: "001_create_orders.sql", destructive: false },
        { name: "002_add_status.sql", destructive: false },
      ],
    }),
    dpl_seed7: JSON.stringify({
      bindings: { d1: ["DB"], kv: ["SESSIONS"], r2: ["ASSETS"] },
      schedules: ["0 */6 * * *"],
    }),
    dpl_seed8: JSON.stringify({
      bindings: { kv: ["CACHE"] },
    }),
  };

  // -- Deployments (live) -----------------------------------------------------
  const deployments = [
    { id: "dpl_seed1", project_id: "proj_seed1", status: "live", created_at: ago30 },
    { id: "dpl_seed2", project_id: "proj_seed1", status: "live", created_at: ago7 },
    { id: "dpl_seed3", project_id: "proj_seed2", status: "live", created_at: ago60 },
    { id: "dpl_seed4", project_id: "proj_seed3", status: "live", created_at: ago30 },
    { id: "dpl_seed5", project_id: "proj_seed3", status: "live", created_at: ago7 },
    { id: "dpl_seed6", project_id: "proj_seed4", status: "live", created_at: ago60 },
    { id: "dpl_seed7", project_id: "proj_seed5", status: "live", created_at: ago30 },
    { id: "dpl_seed8", project_id: "proj_seed6", status: "live", created_at: ago7 },
  ];

  // -- Failed deployments -----------------------------------------------------
  const failedDeployments = [
    {
      id: "dpl_fail1",
      project_id: "proj_seed1",
      status: "failed",
      error_message: "destructive migration rejected: 003_drop_users.sql",
      created_at: ago7,
    },
    {
      id: "dpl_fail2",
      project_id: "proj_seed3",
      status: "failed",
      error_message: "migration failed: SQLITE_ERROR: no such table: orders",
      created_at: ago30,
    },
    {
      id: "dpl_fail3",
      project_id: "proj_seed5",
      status: "failed",
      error_message: "worker upload failed: 500 Internal Server Error",
      created_at: ago60,
    },
  ];

  // -- Today's deployments for alice (deploy count demo) ----------------------
  const todayDeployments = [
    { id: "dpl_today1", project_id: "proj_seed1", status: "live", created_at: now },
    { id: "dpl_today2", project_id: "proj_seed1", status: "live", created_at: now },
  ];

  for (const d of [...deployments, ...failedDeployments, ...todayDeployments]) {
    const manifest = (manifests as Record<string, string>)[d.id];
    const manifestVal = manifest ? `'${manifest.replace(/'/g, "''")}'` : "NULL";
    const errorVal = "error_message" in d && d.error_message ? `'${d.error_message}'` : "NULL";
    const deployedAt = d.status === "live" ? `'${d.created_at}'` : "NULL";
    stmts.push(
      `INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('${d.id}', '${d.project_id}', '${d.status}', ${manifestVal}, ${errorVal}, '${d.created_at}', ${deployedAt})`,
    );
  }

  // -- Resources (D1, KV, R2) -------------------------------------------------
  const resources = [
    {
      id: "res_seed1",
      project_id: "proj_seed1",
      type: "d1",
      cf_id: "a1b2c3d4-0001-4000-8000-000000000001",
      binding_name: "DB",
    },
    {
      id: "res_seed2",
      project_id: "proj_seed1",
      type: "kv",
      cf_id: "a1b2c3d4-0002-4000-8000-000000000002",
      binding_name: "CACHE",
    },
    {
      id: "res_seed3",
      project_id: "proj_seed3",
      type: "d1",
      cf_id: "a1b2c3d4-0003-4000-8000-000000000003",
      binding_name: "DB",
    },
    {
      id: "res_seed4",
      project_id: "proj_seed3",
      type: "r2",
      cf_id: "a1b2c3d4-0004-4000-8000-000000000004",
      binding_name: "UPLOADS",
    },
    {
      id: "res_seed5",
      project_id: "proj_seed5",
      type: "d1",
      cf_id: "a1b2c3d4-0005-4000-8000-000000000005",
      binding_name: "DB",
    },
    {
      id: "res_seed6",
      project_id: "proj_seed5",
      type: "kv",
      cf_id: "a1b2c3d4-0006-4000-8000-000000000006",
      binding_name: "SESSIONS",
    },
    {
      id: "res_seed7",
      project_id: "proj_seed5",
      type: "r2",
      cf_id: "a1b2c3d4-0007-4000-8000-000000000007",
      binding_name: "ASSETS",
    },
  ];

  for (const r of resources) {
    stmts.push(
      `INSERT INTO resources (id, project_id, type, cf_id, binding_name, created_at) VALUES ('${r.id}', '${r.project_id}', '${r.type}', '${r.cf_id}', '${r.binding_name}', '${ago60}')`,
    );
  }

  // -- Admin user -------------------------------------------------------------
  stmts.push(
    `INSERT INTO users (id, provider, provider_id, login, email, github_id, github_login, plan, billing_cycle_start, role, created_at) VALUES ('user_admin', 'google', 'local-admin', 'local-admin', 'admin@localhost', 0, '', 'free', '${now}', 'admin', '${now}')`,
  );

  // -- Execute all statements in one batch ------------------------------------
  d1ExecuteFile(adminDir, stmts);

  s.stop("Seeded 5 users, 6 projects, 13 deployments, 7 resources");

  p.log.success("Created admin user: admin@localhost");

  // 5. Next steps
  const devVarsPath = resolve(adminDir, ".dev.vars");
  p.note(
    [
      "Ensure .dev.vars has:",
      "  DEV_AUTH_BYPASS=true",
      "  JWT_SECRET=dev",
      "",
      `  ${devVarsPath}`,
      "",
      "Then:",
      "  1. pnpm dev",
      "  2. Open http://localhost:8788",
    ].join("\n"),
    "Next steps",
  );

  p.outro("Done!");
}

main();
