import { intro, outro, text, select, isCancel, cancel } from "@clack/prompts";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

function detectRunningAgent(): "claude" | "generic" | null {
  if (process.env.CLAUDE) return "claude";
  if (process.env.CURSOR_SESSION_ID) return "generic";
  if (process.env.CODEX) return "generic";
  return null;
}

function isNonInteractive(): boolean {
  return !process.stdin.isTTY;
}

function readAgentPrompt(): string {
  return readFileSync(join(__dirname, "..", "prompt", "AGENT_PROMPT.md"), "utf-8");
}

function getViteCloudVersion(): string {
  const templatePkg = JSON.parse(
    readFileSync(join(__dirname, "..", "template", "package.json"), "utf-8"),
  );
  return templatePkg.devDependencies["vite-cloud"].replace(/^\^/, "");
}

function createAgentFile(targetDir: string, filePath: string): void {
  const version = getViteCloudVersion();
  const promptContent = readAgentPrompt();
  const openMarker = `<!--injected-by-vite-cloud-v${version}-->`;
  const closeMarker = "<!--/injected-by-vite-cloud-->";
  const block = `${openMarker}\n${promptContent}\n${closeMarker}\n`;
  writeFileSync(join(targetDir, filePath), block);
}

async function main() {
  console.log();
  intro("create-vite-cloud");

  const projectName = await text({
    message: "Project name:",
    placeholder: "my-app",
    defaultValue: "my-app",
    validate(value) {
      if (!value) return "Project name is required";
      if (!/^[a-z0-9-]+$/.test(value))
        return "Project name must be lowercase alphanumeric with dashes";
    },
  });

  if (isCancel(projectName)) {
    cancel("Operation cancelled.");
    process.exit(0);
  }

  const targetDir = resolve(process.cwd(), projectName);

  // Copy template
  const templateDir = join(__dirname, "..", "template");
  mkdirSync(targetDir, { recursive: true });
  cpSync(templateDir, targetDir, { recursive: true });

  // Update package.json with project name
  const pkgPath = join(targetDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  pkg.name = projectName;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  // Agent scaffolding
  const runningAgent = detectRunningAgent();
  if (runningAgent) {
    // Auto-create the right agent file
    const filePath = runningAgent === "claude" ? "CLAUDE.md" : "AGENTS.md";
    createAgentFile(targetDir, filePath);
  } else if (isNonInteractive()) {
    // Non-interactive but no known agent — default to CLAUDE.md
    createAgentFile(targetDir, "CLAUDE.md");
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
      cancel("Operation cancelled.");
      process.exit(0);
    }
    if (agentChoice === "claude") {
      createAgentFile(targetDir, "CLAUDE.md");
    } else if (agentChoice === "generic") {
      createAgentFile(targetDir, "AGENTS.md");
    }
  }

  outro(`Done! Next steps:

  cd ${projectName}
  npm install
  npm run dev

  Your app will be running at http://localhost:5173`);
}

main().catch(console.error);
