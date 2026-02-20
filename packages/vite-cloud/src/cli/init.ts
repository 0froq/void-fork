import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { intro, outro, log, confirm, isCancel, cancel, note, select } from "@clack/prompts";
import { ensureProjectTsconfig } from "../codegen/project-tsconfig";

export interface InitArgs {
  tsconfig: boolean;
  github: boolean;
  agent: boolean;
  skills: boolean;
  prompt: boolean;
}

export function parseInitArgs(args: string[]): InitArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      options: {
        tsconfig: { type: "boolean" },
        github: { type: "boolean" },
        agent: { type: "boolean" },
        skills: { type: "boolean" },
        prompt: { type: "boolean" },
      },
      strict: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Error: ${message}`);
  }

  return {
    tsconfig: parsed.values.tsconfig === true,
    github: parsed.values.github === true,
    agent: parsed.values.agent === true,
    skills: parsed.values.skills === true,
    prompt: parsed.values.prompt === true,
  };
}

interface ProjectState {
  hasTypescript: boolean;
  hasTsconfig: boolean;
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
      // Rebuild with extends first so it appears at the top of the file
      const { extends: ext, ...rest } = tsconfig;
      const ordered = { extends: ext, ...rest };
      writeFileSync(tsconfigPath, JSON.stringify(ordered, null, 2) + "\n");
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
      include: ["src", "routes", "middleware", "crons", "queues"],
    };
    writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + "\n");
    log.success("Created tsconfig.json");

    if (!state.hasTypescript) {
      log.info("Don't forget to install typescript");
    }
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
      - run: pnpm vcc deploy
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
      - run: yarn vcc deploy
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
      - run: bunx vcc deploy
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
      - run: npx vcc deploy
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
    "1. Run: vcc token\n" +
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

interface AgentDetection {
  type: "claude" | "generic" | null;
  filePath: string | null;
}

function detectAgent(root: string): AgentDetection {
  if (existsSync(join(root, ".claude")) || existsSync(join(root, "CLAUDE.md"))) {
    return { type: "claude", filePath: "CLAUDE.md" };
  }
  if (existsSync(join(root, "AGENTS.md"))) {
    return { type: "generic", filePath: "AGENTS.md" };
  }
  return { type: null, filePath: null };
}

function getPackageDir(): string {
  // Walk up from the current file to find the vite-cloud package root.
  // tsdown bundles this as a chunk at dist/ level, so the nesting depth varies.
  let dir = join(fileURLToPath(import.meta.url), "..");
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "package.json"))) {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
      if (pkg.name === "vite-cloud") return dir;
    }
    dir = join(dir, "..");
  }
  throw new Error("Could not find vite-cloud package root");
}

function readAgentPrompt(): string {
  return readFileSync(join(getPackageDir(), "AGENT_PROMPT.md"), "utf-8");
}

function getOwnVersion(): string {
  const pkg = JSON.parse(readFileSync(join(getPackageDir(), "package.json"), "utf-8"));
  return pkg.version;
}

const MARKER_OPEN_RE = /<!--injected-by-vite-cloud-v([\d.]+)-->/;
const MARKER_CLOSE = "<!--/injected-by-vite-cloud-->";
const MARKER_BLOCK_RE =
  /<!--injected-by-vite-cloud-v[\d.]+-->\n[\s\S]*?<!--\/injected-by-vite-cloud-->/;

function injectAgentBlock(root: string, filePath: string): void {
  const fullPath = join(root, filePath);
  const version = getOwnVersion();
  const promptContent = readAgentPrompt();
  const openMarker = `<!--injected-by-vite-cloud-v${version}-->`;
  const block = `${openMarker}\n${promptContent}\n${MARKER_CLOSE}`;

  if (existsSync(fullPath)) {
    const existing = readFileSync(fullPath, "utf-8");
    const match = existing.match(MARKER_OPEN_RE);
    if (match) {
      if (match[1] === version) {
        log.info(`${filePath} already has Vite Cloud instructions (v${version})`);
        return;
      }
      // Replace existing block with updated version
      const updated = existing.replace(MARKER_BLOCK_RE, block);
      writeFileSync(fullPath, updated);
      log.success(`Updated Vite Cloud instructions in ${filePath} (v${match[1]} → v${version})`);
    } else {
      // Append block to end of file
      const separator = existing.endsWith("\n") ? "\n" : "\n\n";
      writeFileSync(fullPath, existing + separator + block + "\n");
      log.success(`Added Vite Cloud instructions to ${filePath}`);
    }
  } else {
    writeFileSync(fullPath, block + "\n");
    log.success(`Created ${filePath} with Vite Cloud instructions`);
  }
}

export async function runInitCommand(root: string, initArgs?: InitArgs): Promise<void> {
  console.log();
  intro("\x1b[34mvite-cloud init\x1b[0m");

  // --prompt: print agent reference prompt to stdout and exit
  if (initArgs?.prompt) {
    let dir = join(fileURLToPath(import.meta.url), "..");
    for (let i = 0; i < 5; i++) {
      const promptPath = join(dir, "getting-started-prompt.txt");
      if (existsSync(promptPath)) {
        process.stdout.write(readFileSync(promptPath, "utf-8"));
        return;
      }
      dir = join(dir, "..");
    }
    return;
  }

  const state = detectProjectState(root);
  const targeted =
    initArgs && (initArgs.tsconfig || initArgs.github || initArgs.agent || initArgs.skills);

  // Step 1: TypeScript / tsconfig
  if (!targeted || initArgs.tsconfig) {
    if (targeted) {
      // --tsconfig flag: run directly without prompting
      state.typescriptWanted = true;
      setupTsconfig(root, state);
    } else if (!state.hasTsconfig && !state.hasTypescript) {
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
  }

  // Generate .vite-cloud/tsconfig.json so the root tsconfig can extend it
  if (state.typescriptWanted) {
    ensureProjectTsconfig(root);
  }

  // Step 2: Agent instructions
  if (!targeted || initArgs?.agent) {
    const detected = detectAgent(root);
    if (targeted) {
      // --agent flag: auto-inject to detected file or default CLAUDE.md
      injectAgentBlock(root, detected.filePath ?? "CLAUDE.md");
    } else if (detected.type) {
      const addAgent = await confirm({
        message: `Add Vite Cloud instructions to ${detected.filePath}?`,
      });
      if (isCancel(addAgent)) {
        cancel("Setup cancelled.");
        process.exit(0);
      }
      if (addAgent) {
        injectAgentBlock(root, detected.filePath!);
      }
    } else {
      const agentChoice = await select({
        message: "Add coding agent instructions?",
        options: [
          { value: "claude", label: "Claude Code (CLAUDE.md)" },
          { value: "generic", label: "Other agents (AGENTS.md)" },
          { value: "skip", label: "Skip" },
        ],
      });
      if (isCancel(agentChoice)) {
        cancel("Setup cancelled.");
        process.exit(0);
      }
      if (agentChoice === "claude") {
        injectAgentBlock(root, "CLAUDE.md");
      } else if (agentChoice === "generic") {
        injectAgentBlock(root, "AGENTS.md");
      }
    }
  }

  // Step 3: Link skills
  if (!targeted || initArgs?.agent || initArgs?.skills) {
    const { detectAgents, linkSkillsForAgents } = await import("./skills");
    const detectedAgents = detectAgents(root);
    if (detectedAgents.length > 0) {
      const agentNames = detectedAgents.map((a) => a.displayName).join(", ");
      if (targeted) {
        linkSkillsForAgents(root);
      } else {
        const linkSkills = await confirm({
          message: `Link vite-cloud skills for ${agentNames}?`,
        });
        if (isCancel(linkSkills)) {
          cancel("Setup cancelled.");
          process.exit(0);
        }
        if (linkSkills) {
          linkSkillsForAgents(root);
        }
      }
    }
  }

  // Step 4: Demo code (only in full interactive flow)
  if (!targeted) {
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
  }

  // Step 5: GitHub Actions
  if (!targeted || initArgs.github) {
    const deployYmlPath = join(root, ".github", "workflows", "deploy.yml");
    if (existsSync(deployYmlPath)) {
      log.warn("deploy.yml already exists, skipping");
    } else if (targeted) {
      // --github flag: run directly without prompting
      setupGithubActions(root, state);
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
  }

  outro("Run `vite dev` to start developing");
}
