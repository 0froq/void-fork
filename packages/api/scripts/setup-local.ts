import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const platformDir = resolve(__dirname, "..");
const seedSql = resolve(__dirname, "seed.sql");
const drizzleDir = resolve(__dirname, "../drizzle");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const force = process.argv.includes("--force");

function run(cmd: string, cwd: string, input?: string): string {
  return execSync(cmd, { cwd, stdio: "pipe", input }).toString();
}

function pgReady(): boolean {
  try {
    run("pg_isready", platformDir);
    return true;
  } catch {
    return false;
  }
}

function adminUserExists(): boolean {
  try {
    const out = run(
      `psql -d void_api_dev -tAc "SELECT id FROM users WHERE id = 'user_admin'" 2>/dev/null`,
      platformDir,
    );
    return out.trim() === "user_admin";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  p.intro("Platform local dev setup");

  if (!pgReady()) {
    p.log.error("PostgreSQL is not running. Start it first:");
    p.log.info("  brew services start postgresql@17   # macOS (Homebrew)");
    p.log.info("  sudo systemctl start postgresql     # Linux");
    p.log.info("  docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:17");
    p.outro("Aborting.");
    return;
  }

  if (!force && adminUserExists()) {
    p.log.info("Local dev already set up (admin user exists). Use --force to re-setup.");
    p.outro("Nothing to do.");
    return;
  }

  const s = p.spinner();

  // 1. Create void_dev role and database (idempotent)
  s.start("Creating local database void_api_dev");
  try {
    run(
      `psql -d postgres -c "CREATE ROLE void_dev WITH LOGIN PASSWORD 'void_dev'" 2>/dev/null`,
      platformDir,
    );
  } catch {
    // Role already exists — fine
  }
  try {
    run("createdb -O void_dev void_api_dev 2>/dev/null", platformDir);
  } catch {
    // Already exists — fine
  }
  // Ensure void_dev owns the database even if it was created before the role
  try {
    run(`psql -d postgres -c "ALTER DATABASE void_api_dev OWNER TO void_dev"`, platformDir);
  } catch {
    // Fine
  }
  s.stop("Database void_api_dev ready");

  // 2. Apply Drizzle migrations
  s.start("Applying migrations");
  const journalPath = resolve(drizzleDir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  for (const entry of journal.entries) {
    const sqlFile = resolve(drizzleDir, `${entry.tag}.sql`);
    const sql = readFileSync(sqlFile, "utf8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((stmt: string) => stmt.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      try {
        run("psql -d void_api_dev", platformDir, stmt);
      } catch {
        // Table/index already exists — fine
      }
    }
  }
  s.stop("Applied migrations");

  // 3. Seed shared data
  s.start("Seeding fake data");
  run(`psql -d void_api_dev -f "${seedSql}"`, platformDir);
  s.stop("Seeded 5 users, 6 projects, 13 deployments, 7 resources");

  // 4. Add local admin user
  s.start("Creating local admin user");
  run(
    `psql -d void_api_dev -c "INSERT INTO users (id, provider, provider_id, login, email, plan, billing_cycle_start, role, created_at) VALUES ('user_admin', 'google', 'local-admin', 'local-admin', 'admin@localhost', 'free', now(), 'admin', now()) ON CONFLICT (id) DO NOTHING"`,
    platformDir,
  );
  s.stop("Created local admin user");

  p.log.success("Created admin user: admin@localhost");

  // 5. Create .dev.vars if missing (API + dashboard)
  const apiDevVars = ["DEV_AUTH_BYPASS=true", "JWT_SECRET=dev", ""].join("\n");
  const dashboardDevVars = ["DEV_AUTH_BYPASS=true", "JWT_SECRET=dev", ""].join("\n");
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

void main();
