import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminDir = resolve(__dirname, "..");
const platformDir = resolve(__dirname, "../../platform");

// ---------------------------------------------------------------------------
// Parse flags
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { github: string } {
  const idx = argv.indexOf("--github");
  if (idx === -1 || !argv[idx + 1]) {
    p.log.error("Missing required flag: --github <username>");
    process.exit(1);
  }
  return { github: argv[idx + 1] };
}

const args = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: "pipe" });
}

function d1Execute(cwd: string, sql: string): void {
  // Use double-quote shell wrapping — escape any embedded double quotes
  const escaped = sql.replace(/"/g, '\\"');
  run(`npx wrangler d1 execute vite-cloud-platform --local --command "${escaped}"`, cwd);
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

  // 2. Apply migrations
  s.start("Applying migrations (platform)");
  run("npx wrangler d1 migrations apply vite-cloud-platform --local", platformDir);
  s.stop("Applied migrations (platform)");

  s.start("Applying migrations (admin)");
  run("npx wrangler d1 migrations apply vite-cloud-platform --local", adminDir);
  s.stop("Applied migrations (admin)");

  // 3. Seed fake data
  s.start("Seeding fake data");

  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  const users = [
    {
      id: "user_seed1",
      provider: "github",
      provider_id: "100001",
      login: "alice",
      email: "alice@example.com",
      plan: "free",
    },
    {
      id: "user_seed2",
      provider: "github",
      provider_id: "100002",
      login: "bob",
      email: "bob@example.com",
      plan: "solo",
    },
    {
      id: "user_seed3",
      provider: "google",
      provider_id: "100003",
      login: "carol",
      email: "carol@example.com",
      plan: "pro",
    },
    {
      id: "user_seed4",
      provider: "github",
      provider_id: "100004",
      login: "dave",
      email: "dave@example.com",
      plan: "sponsored",
    },
    {
      id: "user_seed5",
      provider: "google",
      provider_id: "100005",
      login: "eve",
      email: "eve@example.com",
      plan: "free",
    },
  ];

  for (const u of users) {
    d1Execute(
      adminDir,
      `INSERT INTO users (id, provider, provider_id, login, email, github_id, github_login, plan, billing_cycle_start, role, created_at) VALUES ('${u.id}', '${u.provider}', '${u.provider_id}', '${u.login}', '${u.email}', ${u.provider_id}, '${u.login}', '${u.plan}', '${now}', 'user', '${now}')`,
    );
  }

  const projects = [
    {
      id: "proj_seed1",
      user_id: "user_seed1",
      slug: "my-app",
      name: "my-app",
      mode: "fullstack",
    },
    {
      id: "proj_seed2",
      user_id: "user_seed1",
      slug: "docs-site",
      name: "docs-site",
      mode: "fullstack",
    },
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
      mode: "fullstack",
    },
    {
      id: "proj_seed5",
      user_id: "user_seed3",
      slug: "dashboard",
      name: "dashboard",
      mode: "fullstack",
    },
    {
      id: "proj_seed6",
      user_id: "user_seed4",
      slug: "blog",
      name: "blog",
      mode: "fullstack",
    },
  ];

  for (const proj of projects) {
    d1Execute(
      adminDir,
      `INSERT INTO projects (id, user_id, slug, name, mode, created_at) VALUES ('${proj.id}', '${proj.user_id}', '${proj.slug}', '${proj.name}', '${proj.mode}', '${now}')`,
    );
  }

  const deployments = [
    { id: "dpl_seed1", project_id: "proj_seed1" },
    { id: "dpl_seed2", project_id: "proj_seed1" },
    { id: "dpl_seed3", project_id: "proj_seed2" },
    { id: "dpl_seed4", project_id: "proj_seed3" },
    { id: "dpl_seed5", project_id: "proj_seed3" },
    { id: "dpl_seed6", project_id: "proj_seed4" },
    { id: "dpl_seed7", project_id: "proj_seed5" },
    { id: "dpl_seed8", project_id: "proj_seed6" },
  ];

  for (const d of deployments) {
    d1Execute(
      adminDir,
      `INSERT INTO deployments (id, project_id, status, created_at, deployed_at) VALUES ('${d.id}', '${d.project_id}', 'live', '${now}', '${now}')`,
    );
  }

  s.stop("Seeded 5 users, 6 projects, 8 deployments");

  // 4. Seed admin user from GitHub
  s.start(`Fetching GitHub user: ${args.github}`);

  const res = await fetch(`https://api.github.com/users/${args.github}`, {
    headers: { "User-Agent": "vite-cloud-admin-setup" },
  });
  if (!res.ok) {
    s.stop(`Failed to fetch GitHub user (${res.status})`);
    p.log.error(`Could not fetch https://api.github.com/users/${args.github}`);
    process.exit(1);
  }

  const gh = (await res.json()) as { id: number; login: string; email: string | null };

  d1Execute(
    adminDir,
    `INSERT INTO users (id, provider, provider_id, login, email, github_id, github_login, plan, billing_cycle_start, role, created_at) VALUES ('user_admin', 'github', '${gh.id}', '${gh.login}', ${gh.email ? `'${gh.email}'` : "NULL"}, ${gh.id}, '${gh.login}', 'free', '${now}', 'admin', '${now}')`,
  );

  s.stop(`Created admin user: ${gh.login} (github:${gh.id})`);

  // 5. Check .dev.vars
  const devVarsPath = resolve(adminDir, ".dev.vars");
  const requiredKeys = [
    "JWT_SECRET",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "AUTH_REDIRECT_URI",
  ];

  if (existsSync(devVarsPath)) {
    const content = readFileSync(devVarsPath, "utf-8");
    const missing = requiredKeys.filter((k) => !content.includes(k));
    if (missing.length > 0) {
      p.log.warn(`Missing keys in .dev.vars:\n${missing.map((k) => `  ${k}=<value>`).join("\n")}`);
    } else {
      p.log.success("Checked .dev.vars — all required keys present");
    }
  } else {
    p.log.warn(
      `No .dev.vars found. Create ${devVarsPath} with:\n${requiredKeys.map((k) => `  ${k}=<value>`).join("\n")}`,
    );
  }

  // 6. Next steps
  p.note(
    [
      "1. Start the platform:  cd ../platform && pnpm dev",
      "2. Start the admin:     pnpm dev",
      "3. Open:                http://localhost:8788",
    ].join("\n"),
    "Next steps",
  );

  p.outro("Done!");
}

main();
