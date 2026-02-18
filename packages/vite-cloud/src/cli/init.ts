import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { intro, outro, log, confirm, multiselect, isCancel, cancel, note } from "@clack/prompts";

interface ProjectState {
  hasTypescript: boolean;
  hasTsconfig: boolean;
  hasViteCloudJson: boolean;
  hasGithubWorkflows: boolean;
  hasRoutes: boolean;
  hasMigrations: boolean;
  packageManager: "pnpm" | "yarn" | "bun" | "npm";
  typescriptWanted: boolean;
}

function detectProjectState(root: string): ProjectState {
  let hasTypescript = false;
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    hasTypescript = "typescript" in allDeps || "@typescript/native-preview" in allDeps;
  } catch {
    // no package.json
  }

  let packageManager: ProjectState["packageManager"] = "npm";
  if (existsSync(join(root, "pnpm-lock.yaml"))) {
    packageManager = "pnpm";
  } else if (existsSync(join(root, "yarn.lock"))) {
    packageManager = "yarn";
  } else if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) {
    packageManager = "bun";
  }

  return {
    hasTypescript,
    hasTsconfig: existsSync(join(root, "tsconfig.json")),
    hasViteCloudJson: existsSync(join(root, "vite-cloud.json")),
    hasGithubWorkflows: existsSync(join(root, ".github", "workflows")),
    hasRoutes: existsSync(join(root, "routes")),
    hasMigrations: existsSync(join(root, "migrations")),
    packageManager,
    typescriptWanted: hasTypescript,
  };
}

function setupTsconfig(root: string, state: ProjectState): void {
  const tsconfigPath = join(root, "tsconfig.json");

  if (state.hasTsconfig) {
    // Case C: existing tsconfig — check and offer fixes
    let tsconfig: any;
    try {
      tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf-8"));
    } catch {
      log.warn("Could not parse tsconfig.json, skipping");
      return;
    }

    let updated = false;

    // Check extends
    const extendsValue = tsconfig.extends;
    const target = "./.vite-cloud/tsconfig.json";
    const hasCorrectExtends =
      extendsValue === target || (Array.isArray(extendsValue) && extendsValue.includes(target));

    if (!hasCorrectExtends) {
      if (typeof extendsValue === "string") {
        tsconfig.extends = [extendsValue, target];
      } else if (Array.isArray(extendsValue)) {
        tsconfig.extends = [...extendsValue, target];
      } else {
        tsconfig.extends = target;
      }
      updated = true;
      log.success("Updated tsconfig.json — added extends .vite-cloud/tsconfig.json");
    }

    // Check types
    if (!tsconfig.compilerOptions) {
      tsconfig.compilerOptions = {};
    }
    const types: string[] = tsconfig.compilerOptions.types ?? [];
    if (!types.includes("vite-cloud/env")) {
      types.push("vite-cloud/env");
      updated = true;
      log.success("Updated tsconfig.json — added vite-cloud/env to types");
    }

    // Remove @cloudflare/workers-types — vite-cloud/env includes it
    const cfIdx = types.indexOf("@cloudflare/workers-types");
    if (cfIdx !== -1) {
      types.splice(cfIdx, 1);
      updated = true;
      log.success(
        "Removed @cloudflare/workers-types from tsconfig types (included in vite-cloud/env)",
      );
    }

    tsconfig.compilerOptions.types = types;

    if (updated) {
      writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + "\n");
    } else {
      log.success("tsconfig.json looks good");
    }

    // Remove @cloudflare/workers-types from package.json — vite-cloud/env includes it
    try {
      const pkgPath = join(root, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      let pkgUpdated = false;
      if (pkg.dependencies?.["@cloudflare/workers-types"]) {
        delete pkg.dependencies["@cloudflare/workers-types"];
        pkgUpdated = true;
      }
      if (pkg.devDependencies?.["@cloudflare/workers-types"]) {
        delete pkg.devDependencies["@cloudflare/workers-types"];
        pkgUpdated = true;
      }
      if (pkgUpdated) {
        writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
        log.success(
          "Removed @cloudflare/workers-types from package.json (included in vite-cloud/env)",
        );
        log.info(`Re-run ${state.packageManager} install to update your lockfile`);
      }
    } catch {
      // no package.json or parse error — skip
    }
  } else {
    // Case B: no tsconfig — create recommended one
    const tsconfig = {
      extends: "./.vite-cloud/tsconfig.json",
      compilerOptions: {
        target: "ES2022",
        module: "ES2022",
        moduleResolution: "bundler",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        types: ["vite-cloud/env"],
      },
      include: ["src", "routes", "middleware"],
    };
    writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + "\n");
    log.success("Created tsconfig.json");

    if (!state.hasTypescript) {
      log.info("Don't forget to install typescript");
    }
  }
}

async function promptAuth(root: string, state: ProjectState): Promise<void> {
  const configPath = join(root, "vite-cloud.json");

  // Check if auth is already configured
  if (state.hasViteCloudJson) {
    try {
      const existing = JSON.parse(readFileSync(configPath, "utf-8"));
      if (existing.auth) {
        log.info("Auth already configured in vite-cloud.json");
        return;
      }
    } catch {
      // will be overwritten
    }
  }

  const providers = await multiselect({
    message: "Enable authentication? \x1b[2m(space to select, enter to confirm)\x1b[0m",
    options: [
      { value: "github", label: "GitHub OAuth" },
      { value: "google", label: "Google OAuth" },
      { value: "email", label: "Email/Password" },
    ],
    required: false,
  });

  if (isCancel(providers)) {
    cancel("Setup cancelled.");
    process.exit(0);
  }

  if (providers.length === 0) {
    log.info("Skipping authentication setup");
    return;
  }

  let config: Record<string, unknown> = {
    $schema: "https://unpkg.com/vite-cloud/schema.json",
  };

  if (state.hasViteCloudJson) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      // start fresh
    }
  }

  config.auth = providers;
  if (!config.$schema) {
    config.$schema = "https://unpkg.com/vite-cloud/schema.json";
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  if (state.hasViteCloudJson) {
    log.success("Updated vite-cloud.json — added auth config");
  } else {
    log.success("Created vite-cloud.json");
  }
}

function getNodeVersionLine(root: string): string {
  if (existsSync(join(root, ".node-version"))) {
    return "node-version-file: .node-version";
  }
  return "node-version: lts/*";
}

function getWorkflowYaml(root: string, pm: ProjectState["packageManager"]): string {
  const nodeVersion = getNodeVersionLine(root);
  switch (pm) {
    case "pnpm":
      return `name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          ${nodeVersion}
          cache: pnpm
      - run: pnpm install
      - run: pnpm vcd deploy
        env:
          VITE_CLOUD_TOKEN: \${{ secrets.VITE_CLOUD_TOKEN }}
`;
    case "yarn":
      return `name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          ${nodeVersion}
          cache: yarn
      - run: yarn install --immutable
      - run: yarn vcd deploy
        env:
          VITE_CLOUD_TOKEN: \${{ secrets.VITE_CLOUD_TOKEN }}
`;
    case "bun":
      return `name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bunx vcd deploy
        env:
          VITE_CLOUD_TOKEN: \${{ secrets.VITE_CLOUD_TOKEN }}
`;
    default:
      return `name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          ${nodeVersion}
          cache: npm
      - run: npm ci
      - run: npx vcd deploy
        env:
          VITE_CLOUD_TOKEN: \${{ secrets.VITE_CLOUD_TOKEN }}
`;
  }
}

function setupGithubActions(root: string, state: ProjectState): void {
  const workflowPath = join(root, ".github", "workflows", "deploy.yml");

  if (existsSync(workflowPath)) {
    log.warn("deploy.yml already exists, skipping");
    return;
  }

  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(workflowPath, getWorkflowYaml(root, state.packageManager));
  log.success("Created .github/workflows/deploy.yml");

  note(
    "1. Run: vcd token\n" +
      "2. In your repo → Settings → Secrets → Actions → New secret\n" +
      "3. Name: VITE_CLOUD_TOKEN, paste the token as value",
    "Add your deploy token as a GitHub secret",
  );
}

function scaffoldDemo(root: string): void {
  // Migration
  mkdirSync(join(root, "migrations"), { recursive: true });
  writeFileSync(
    join(root, "migrations", "001_create_posts.sql"),
    `CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
`,
  );
  log.success("Created migrations/001_create_posts.sql");

  // API route
  mkdirSync(join(root, "routes", "api"), { recursive: true });
  writeFileSync(
    join(root, "routes", "api", "posts.ts"),
    `import { defineHandler } from "vite-cloud";
import { db } from "vite-cloud/db";

// GET /api/posts — returns all posts, fully typed from migration schema
export const GET = defineHandler(async () => {
  return db.list("posts");
});
`,
  );
  log.success("Created routes/api/posts.ts");

  // Frontend demo
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "demo.ts"),
    `import { fetch } from "vite-cloud/client";

// Fully typed: response type is inferred from the GET handler's return type,
// which is derived from the migration schema. No manual types needed.
const posts = await fetch("/api/posts");

console.log(posts);
// posts[0].title  ← string (type-checked)
// posts[0].body   ← string (type-checked)
// posts[0].nope   ← TypeScript error
`,
  );
  log.success("Created src/demo.ts");

  note(
    "SQL migration → DB types → Route handler → Route types → Typed fetch\n\n" +
      "Run `vite dev` and open src/demo.ts to see the types in action.\n" +
      "Try changing the migration or handler — types update automatically.",
    "Type Safety Demo",
  );
}

export async function runInitCommand(root: string): Promise<void> {
  console.log();
  intro("\x1b[34mvite-cloud init\x1b[0m");

  const state = detectProjectState(root);

  // Step 2: TypeScript / tsconfig
  if (!state.hasTsconfig && !state.hasTypescript) {
    const useTs = await confirm({ message: "Do you want to use TypeScript?" });
    if (isCancel(useTs)) {
      cancel("Setup cancelled.");
      process.exit(0);
    }
    if (!useTs) {
      log.info("Skipping TypeScript setup");
      state.typescriptWanted = false;
    } else {
      state.typescriptWanted = true;
      setupTsconfig(root, state);
    }
  } else {
    state.typescriptWanted = true;
    setupTsconfig(root, state);
  }

  // Step 3: Authentication
  await promptAuth(root, state);

  // Step 4: Demo code
  if (state.hasRoutes || state.hasMigrations) {
    log.info("Project already has routes or migrations, skipping demo");
  } else if (!state.typescriptWanted) {
    // Demo requires TypeScript for the type pipeline
  } else {
    const scaffold = await confirm({
      message: "Scaffold demo code? (migration + API route + frontend fetch)",
    });
    if (isCancel(scaffold)) {
      cancel("Setup cancelled.");
      process.exit(0);
    }
    if (scaffold) {
      scaffoldDemo(root);
    }
  }

  // Step 5: GitHub Actions
  const deployYmlPath = join(root, ".github", "workflows", "deploy.yml");
  if (existsSync(deployYmlPath)) {
    log.warn("deploy.yml already exists, skipping");
  } else {
    const setupGha = await confirm({ message: "Set up GitHub Actions deployment?" });
    if (isCancel(setupGha)) {
      cancel("Setup cancelled.");
      process.exit(0);
    }
    if (setupGha) {
      setupGithubActions(root, state);
    }
  }

  // Step 6: Summary
  outro("Run `vite dev` to start developing");
}
