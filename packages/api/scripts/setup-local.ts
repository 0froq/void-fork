import { execSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const platformDir = resolve(__dirname, "..");
const seedSql = resolve(__dirname, "seed.sql");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const force = process.argv.includes("--force");

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: "pipe" }).toString();
}

function adminUserExists(): boolean {
  const state = resolve(platformDir, ".wrangler/state");
  if (!existsSync(state)) return false;
  try {
    const out = run(
      `npx wrangler d1 execute void-api --local --command "SELECT id FROM users WHERE id = 'user_admin'" --json`,
      platformDir,
    );
    const results = JSON.parse(out);
    return results[0]?.results?.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  p.intro("Platform local dev setup");

  if (!force && adminUserExists()) {
    p.log.info("Local dev already set up (admin user exists). Use --force to re-setup.");
    p.outro("Nothing to do.");
    return;
  }

  // 1. Reset local D1 state
  const s = p.spinner();

  s.start("Resetting local D1 state");
  const state = resolve(platformDir, ".wrangler/state");
  if (existsSync(state)) {
    rmSync(state, { recursive: true });
  }
  s.stop("Reset local D1 state");

  // 2. Apply migrations
  s.start("Applying migrations");
  run("npx wrangler d1 migrations apply void-api --local", platformDir);
  s.stop("Applied migrations");

  // 3. Seed shared data (same SQL used for staging)
  s.start("Seeding fake data");
  run(`npx wrangler d1 execute void-api --local --file "${seedSql}"`, platformDir);
  s.stop("Seeded 5 users, 6 projects, 13 deployments, 7 resources");

  // 4. Add local admin user (local-only, not in shared seed)
  s.start("Creating local admin user");
  run(
    `npx wrangler d1 execute void-api --local --command "INSERT INTO users (id, provider, provider_id, login, email, plan, billing_cycle_start, role, created_at) VALUES ('user_admin', 'google', 'local-admin', 'local-admin', 'admin@localhost', 'free', datetime('now'), 'admin', datetime('now'))"`,
    platformDir,
  );
  s.stop("Created local admin user");

  p.log.success("Created admin user: admin@localhost");

  // 5. Create .dev.vars if missing (API + dashboard)
  const apiDevVars = ["DEV_AUTH_BYPASS=true", "JWT_SECRET=dev", ""].join("\n");
  const dashboardDevVars = [
    "DEV_AUTH_BYPASS=true",
    "JWT_SECRET=dev",
    "API_URL=http://localhost:8787",
    "",
  ].join("\n");
  const devVarsConfigs: [string, string][] = [
    [platformDir, apiDevVars],
    [resolve(platformDir, "../dashboard"), dashboardDevVars],
  ];
  for (const [dir, content] of devVarsConfigs) {
    const devVarsPath = resolve(dir, ".dev.vars");
    if (!existsSync(devVarsPath)) {
      writeFileSync(devVarsPath, content);
      p.log.success(`Created ${devVarsPath}`);
    } else {
      p.log.info(`.dev.vars already exists at ${devVarsPath}`);
    }
  }

  // 6. Next steps
  p.note(
    ["Run:", "  1. pnpm dev", "  2. Open http://localhost:8787/admin/"].join("\n"),
    "Next steps",
  );

  p.outro("Done!");
}

main();
