import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function getPackageDir(): string {
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

export interface McpConfigTarget {
  /** Config file path relative to project root, e.g. ".claude/settings.json" */
  filePath: string;
  /** JSON key that holds MCP server entries, e.g. "mcpServers" or "servers" */
  rootKey: string;
  /** Extra fields merged into the server entry, e.g. { type: "stdio" } for VS Code */
  extraFields?: Record<string, string>;
}

// Agent configs: project-local skillsDir and how to detect presence in the project root.
// Based on https://github.com/vercel-labs/skills/blob/main/src/agents.ts
export interface AgentConfig {
  displayName: string;
  skillsDir: string;
  detect: (root: string) => boolean;
  /** Project-level config files where MCP server entries can be auto-written */
  mcpConfig?: McpConfigTarget[];
  /** Fallback hint printed when the agent has no project-level config support */
  mcpHint?: string;
}

const agents: Record<string, AgentConfig> = {
  "claude-code": {
    displayName: "Claude Code",
    skillsDir: ".claude/skills",
    detect: (root) => existsSync(join(root, ".claude")) || existsSync(join(root, "CLAUDE.md")),
    mcpConfig: [
      { filePath: ".claude/settings.json", rootKey: "mcpServers" },
      { filePath: ".claude/settings.local.json", rootKey: "mcpServers" },
    ],
  },
  amp: {
    displayName: "Amp",
    skillsDir: ".agents/skills",
    detect: (root) => existsSync(join(root, ".agents")),
    mcpHint:
      "Run `npx vcc mcp` — this starts a stdio MCP server. See your agent's docs for how to add a local MCP server.",
  },
  codex: {
    displayName: "Codex",
    skillsDir: ".codex/skills",
    detect: (root) => existsSync(join(root, ".codex")),
    mcpHint: "codex mcp add vite-cloud -- npx vcc mcp",
  },
  cursor: {
    displayName: "Cursor",
    skillsDir: ".cursor/skills",
    detect: (root) => existsSync(join(root, ".cursor")),
    mcpConfig: [{ filePath: ".cursor/mcp.json", rootKey: "mcpServers" }],
  },
  windsurf: {
    displayName: "Windsurf",
    skillsDir: ".windsurf/skills",
    detect: (root) => existsSync(join(root, ".windsurf")),
    mcpConfig: [{ filePath: ".windsurf/mcp.json", rootKey: "mcpServers" }],
  },
  "gemini-cli": {
    displayName: "Gemini CLI",
    skillsDir: ".gemini/skills",
    detect: (root) => existsSync(join(root, ".gemini")),
    mcpHint: "gemini mcp add vite-cloud -- npx vcc mcp",
  },
  "github-copilot": {
    displayName: "GitHub Copilot",
    skillsDir: ".github/skills",
    detect: (root) => existsSync(join(root, ".github")),
    mcpConfig: [
      { filePath: ".vscode/mcp.json", rootKey: "servers", extraFields: { type: "stdio" } },
    ],
  },
  cline: {
    displayName: "Cline",
    skillsDir: ".cline/skills",
    detect: (root) => existsSync(join(root, ".cline")),
    mcpHint:
      "Run `npx vcc mcp` — this starts a stdio MCP server. See your agent's docs for how to add a local MCP server.",
  },
  roo: {
    displayName: "Roo Code",
    skillsDir: ".roo/skills",
    detect: (root) => existsSync(join(root, ".roo")),
    mcpConfig: [{ filePath: ".roo/mcp.json", rootKey: "mcpServers" }],
  },
  kilo: {
    displayName: "Kilo Code",
    skillsDir: ".kilocode/skills",
    detect: (root) => existsSync(join(root, ".kilocode")),
    mcpHint:
      "Run `npx vcc mcp` — this starts a stdio MCP server. See your agent's docs for how to add a local MCP server.",
  },
  continue: {
    displayName: "Continue",
    skillsDir: ".continue/skills",
    detect: (root) => existsSync(join(root, ".continue")),
    mcpHint:
      "Run `npx vcc mcp` — this starts a stdio MCP server. See your agent's docs for how to add a local MCP server.",
  },
  goose: {
    displayName: "Goose",
    skillsDir: ".goose/skills",
    detect: (root) => existsSync(join(root, ".goose")),
    mcpHint:
      "Run `npx vcc mcp` — this starts a stdio MCP server. See your agent's docs for how to add a local MCP server.",
  },
  opencode: {
    displayName: "OpenCode",
    skillsDir: ".opencode/skills",
    detect: (root) => existsSync(join(root, ".opencode")),
    mcpHint:
      "Run `npx vcc mcp` — this starts a stdio MCP server. See your agent's docs for how to add a local MCP server.",
  },
  trae: {
    displayName: "Trae",
    skillsDir: ".trae/skills",
    detect: (root) => existsSync(join(root, ".trae")),
    mcpHint:
      "Run `npx vcc mcp` — this starts a stdio MCP server. See your agent's docs for how to add a local MCP server.",
  },
  junie: {
    displayName: "Junie",
    skillsDir: ".junie/skills",
    detect: (root) => existsSync(join(root, ".junie")),
    mcpHint:
      "Run `npx vcc mcp` — this starts a stdio MCP server. See your agent's docs for how to add a local MCP server.",
  },
  "kiro-cli": {
    displayName: "Kiro CLI",
    skillsDir: ".kiro/skills",
    detect: (root) => existsSync(join(root, ".kiro")),
    mcpHint:
      "Run `npx vcc mcp` — this starts a stdio MCP server. See your agent's docs for how to add a local MCP server.",
  },
  zencoder: {
    displayName: "Zencoder",
    skillsDir: ".zencoder/skills",
    detect: (root) => existsSync(join(root, ".zencoder")),
    mcpHint:
      "Run `npx vcc mcp` — this starts a stdio MCP server. See your agent's docs for how to add a local MCP server.",
  },
  "qwen-code": {
    displayName: "Qwen Code",
    skillsDir: ".qwen/skills",
    detect: (root) => existsSync(join(root, ".qwen")),
    mcpHint:
      "Run `npx vcc mcp` — this starts a stdio MCP server. See your agent's docs for how to add a local MCP server.",
  },
};

export function detectAgents(root: string): AgentConfig[] {
  return Object.values(agents).filter((a) => a.detect(root));
}
