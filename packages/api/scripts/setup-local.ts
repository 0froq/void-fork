import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const platformDir = resolve(__dirname, "..");
const seedSql = resolve(__dirname, "seed.sql");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: "pipe" });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  p.intro("Platform local dev setup");

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
    `npx wrangler d1 execute void-api --local --command "INSERT INTO users (id, provider, provider_id, login, email, github_id, github_login, plan, billing_cycle_start, role, created_at) VALUES ('user_admin', 'google', 'local-admin', 'local-admin', 'admin@localhost', 0, '', 'free', datetime('now'), 'admin', datetime('now'))"`,
    platformDir,
  );
  s.stop("Created local admin user");

  p.log.success("Created admin user: admin@localhost");

  // 5. Next steps
  const devVarsPath = resolve(platformDir, ".dev.vars");
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
      "  2. Open http://localhost:8787/admin/",
    ].join("\n"),
    "Next steps",
  );

  p.outro("Done!");
}

main();
