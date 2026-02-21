import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { intro, outro, log, confirm, isCancel, cancel, note, select } from "@clack/prompts";
import { ensureProjectTsconfig } from "../codegen/project-tsconfig";
import { detectAgents, getPackageDir, type AgentConfig, type McpConfigTarget } from "./agents";
import { cliTitle } from "./output";

export interface InitArgs {
  tsconfig: boolean;
  github: boolean;
  agents: boolean;
}

export function parseInitArgs(args: string[]): InitArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      options: {
        tsconfig: { type: "boolean" },
        github: { type: "boolean" },
        agents: { type: "boolean" },
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
    agents: parsed.values.agents === true,
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

function detectAgentForInstructions(root: string, agents: AgentConfig[]): AgentDetection {
  if (agents.some((a) => a.skillsDir === ".claude/skills")) {
    return { type: "claude", filePath: "CLAUDE.md" };
  }
  if (existsSync(join(root, "CLAUDE.md"))) {
    return { type: "claude", filePath: "CLAUDE.md" };
  }
  if (existsSync(join(root, "AGENTS.md"))) {
    return { type: "generic", filePath: "AGENTS.md" };
  }
  if (agents.length > 0) {
    return { type: "generic", filePath: "AGENTS.md" };
  }
  return { type: null, filePath: null };
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

function writeMcpConfigForTarget(root: string, target: McpConfigTarget): void {
  const fullPath = join(root, target.filePath);
  let existing: Record<string, any> = {};
  if (existsSync(fullPath)) {
    try {
      existing = JSON.parse(readFileSync(fullPath, "utf-8"));
    } catch {
      // unparseable — start fresh
    }
  }

  if (!existing[target.rootKey]) {
    existing[target.rootKey] = {};
  }

  if (existing[target.rootKey]["vite-cloud"]) {
    log.info(`${target.filePath} already has vite-cloud MCP config`);
    return;
  }

  existing[target.rootKey]["vite-cloud"] = {
    command: "npx",
    args: ["vcc", "mcp"],
    ...target.extraFields,
  };

  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, JSON.stringify(existing, null, 2) + "\n");
  log.success(`Added vite-cloud MCP server to ${target.filePath}`);
}

async function setupMcpConfig(
  root: string,
  targeted: boolean,
  detected: AgentConfig[],
): Promise<void> {
  const mcpAgents: { agent: AgentConfig; targets: McpConfigTarget[] }[] = [];
  const hintAgents: { agent: AgentConfig; hint: string }[] = [];

  for (const agent of detected) {
    if (agent.mcpConfig) {
      mcpAgents.push({ agent, targets: agent.mcpConfig });
    } else if (agent.mcpHint) {
      hintAgents.push({ agent, hint: agent.mcpHint });
    }
  }

  if (detected.length === 0) {
    note(
      JSON.stringify(
        {
          "vite-cloud": {
            command: "npx",
            args: ["vcc", "mcp"],
          },
        },
        null,
        2,
      ),
      "Add this MCP server config to your agent",
    );
    return;
  }

  // Print hints for agents without project-level config
  for (const { agent, hint } of hintAgents) {
    log.info(`${agent.displayName}: ${hint}`);
  }

  // Write config for agents with project-level support
  for (const { agent, targets } of mcpAgents) {
    let target: McpConfigTarget;

    if (targets.length === 1) {
      target = targets[0];
    } else {
      // Check which config files already exist on disk
      const existingTargets = targets.filter((t) => existsSync(join(root, t.filePath)));

      if (existingTargets.length === 1) {
        target = existingTargets[0];
      } else if (existingTargets.length >= 2) {
        // Multiple exist — always prompt to disambiguate
        const chosen = await select({
          message: `${agent.displayName}: multiple config files found — which one?`,
          options: existingTargets.map((t) => ({ value: t.filePath, label: t.filePath })),
        });
        if (isCancel(chosen)) {
          cancel("Setup cancelled.");
          process.exit(0);
        }
        target = existingTargets.find((t) => t.filePath === chosen)!;
      } else {
        // None exist — use first (conventional default)
        target = targets[0];
      }
    }

    if (!targeted) {
      const ok = await confirm({
        message: `Add vite-cloud MCP server to ${target.filePath}?`,
      });
      if (isCancel(ok)) {
        cancel("Setup cancelled.");
        process.exit(0);
      }
      if (!ok) continue;
    }

    writeMcpConfigForTarget(root, target);
  }
}

export async function runInitCommand(root: string, initArgs?: InitArgs): Promise<void> {
  console.log();
  intro(cliTitle("init"));

  const state = detectProjectState(root);
  const targeted = initArgs && (initArgs.tsconfig || initArgs.github || initArgs.agents);

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

  // Steps 2–4: Agent instructions, skills, MCP config
  if (!targeted || initArgs?.agents) {
    const detectedAgents = detectAgents(root);

    // Step 2: Agent instructions
    const agentDetection = detectAgentForInstructions(root, detectedAgents);
    if (targeted) {
      // --agents flag: auto-inject to detected file or default CLAUDE.md
      injectAgentBlock(root, agentDetection.filePath ?? "CLAUDE.md");
    } else if (agentDetection.type) {
      const addAgent = await confirm({
        message: `Add Vite Cloud instructions to ${agentDetection.filePath}?`,
      });
      if (isCancel(addAgent)) {
        cancel("Setup cancelled.");
        process.exit(0);
      }
      if (addAgent) {
        injectAgentBlock(root, agentDetection.filePath!);
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

    // Step 3: Link skills
    if (detectedAgents.length > 0) {
      const { linkSkillsForAgents } = await import("./skills");
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

    // Step 4: MCP config
    await setupMcpConfig(root, !!targeted, detectedAgents);
  }

  // Step 5: Demo code (only in full interactive flow)
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

  // Step 6: GitHub Actions
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
