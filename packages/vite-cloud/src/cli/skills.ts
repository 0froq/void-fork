import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "@clack/prompts";

function getPackageDir(): string {
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

interface SkillInfo {
  dirName: string;
  name: string;
  description: string;
}

function parseSkills(skillsDir: string): SkillInfo[] {
  if (!existsSync(skillsDir)) return [];
  const entries = readdirSync(skillsDir, { withFileTypes: true });
  const skills: SkillInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMd = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    const content = readFileSync(skillMd, "utf-8");
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatter) continue;
    const nameMatch = frontmatter[1].match(/^name:\s*(.+)$/m);
    const descMatch = frontmatter[1].match(/^description:\s*(.+)$/m);
    skills.push({
      dirName: entry.name,
      name: nameMatch ? nameMatch[1].trim() : entry.name,
      description: descMatch ? descMatch[1].trim() : "",
    });
  }
  return skills;
}

// Agent configs: project-local skillsDir and how to detect presence in the project root.
// Based on https://github.com/vercel-labs/skills/blob/main/src/agents.ts
interface AgentConfig {
  displayName: string;
  skillsDir: string;
  detect: (root: string) => boolean;
}

const agents: Record<string, AgentConfig> = {
  "claude-code": {
    displayName: "Claude Code",
    skillsDir: ".claude/skills",
    detect: (root) => existsSync(join(root, ".claude")) || existsSync(join(root, "CLAUDE.md")),
  },
  amp: {
    displayName: "Amp",
    skillsDir: ".agents/skills",
    detect: (root) => existsSync(join(root, ".agents")),
  },
  codex: {
    displayName: "Codex",
    skillsDir: ".codex/skills",
    detect: (root) => existsSync(join(root, ".codex")),
  },
  cursor: {
    displayName: "Cursor",
    skillsDir: ".cursor/skills",
    detect: (root) => existsSync(join(root, ".cursor")),
  },
  windsurf: {
    displayName: "Windsurf",
    skillsDir: ".windsurf/skills",
    detect: (root) => existsSync(join(root, ".windsurf")),
  },
  "gemini-cli": {
    displayName: "Gemini CLI",
    skillsDir: ".gemini/skills",
    detect: (root) => existsSync(join(root, ".gemini")),
  },
  "github-copilot": {
    displayName: "GitHub Copilot",
    skillsDir: ".github/skills",
    detect: (root) => existsSync(join(root, ".github")),
  },
  cline: {
    displayName: "Cline",
    skillsDir: ".cline/skills",
    detect: (root) => existsSync(join(root, ".cline")),
  },
  roo: {
    displayName: "Roo Code",
    skillsDir: ".roo/skills",
    detect: (root) => existsSync(join(root, ".roo")),
  },
  kilo: {
    displayName: "Kilo Code",
    skillsDir: ".kilocode/skills",
    detect: (root) => existsSync(join(root, ".kilocode")),
  },
  continue: {
    displayName: "Continue",
    skillsDir: ".continue/skills",
    detect: (root) => existsSync(join(root, ".continue")),
  },
  goose: {
    displayName: "Goose",
    skillsDir: ".goose/skills",
    detect: (root) => existsSync(join(root, ".goose")),
  },
  opencode: {
    displayName: "OpenCode",
    skillsDir: ".opencode/skills",
    detect: (root) => existsSync(join(root, ".opencode")),
  },
  trae: {
    displayName: "Trae",
    skillsDir: ".trae/skills",
    detect: (root) => existsSync(join(root, ".trae")),
  },
  junie: {
    displayName: "Junie",
    skillsDir: ".junie/skills",
    detect: (root) => existsSync(join(root, ".junie")),
  },
  "kiro-cli": {
    displayName: "Kiro CLI",
    skillsDir: ".kiro/skills",
    detect: (root) => existsSync(join(root, ".kiro")),
  },
  zencoder: {
    displayName: "Zencoder",
    skillsDir: ".zencoder/skills",
    detect: (root) => existsSync(join(root, ".zencoder")),
  },
  "qwen-code": {
    displayName: "Qwen Code",
    skillsDir: ".qwen/skills",
    detect: (root) => existsSync(join(root, ".qwen")),
  },
};

export function detectAgents(root: string): AgentConfig[] {
  return Object.values(agents).filter((a) => a.detect(root));
}

function linkSkills(
  root: string,
  skillsDir: string,
  skills: SkillInfo[],
  agentSkillsDir: string,
): number {
  const targetDir = join(root, agentSkillsDir);
  mkdirSync(targetDir, { recursive: true });

  let linked = 0;
  for (const skill of skills) {
    const linkPath = join(targetDir, skill.dirName);
    const sourcePath = join(skillsDir, skill.dirName);
    const relativeTarget = relative(targetDir, sourcePath);

    if (existsSync(linkPath)) {
      try {
        const existing = readlinkSync(linkPath);
        if (existing === relativeTarget) {
          log.info(`  ${skill.name} — already linked`);
          continue;
        }
      } catch {
        // not a symlink
      }
      log.warn(`  ${skill.name} — path exists but is not the expected symlink, skipping`);
      continue;
    }

    symlinkSync(relativeTarget, linkPath);
    log.success(`  ${skill.name} — linked`);
    linked++;
  }
  return linked;
}

/**
 * Link skills for all detected agents. Returns total number of newly linked skills.
 * Used by `vcc init` (interactive flow and `--agent`/`--skills` flags).
 */
export function linkSkillsForAgents(root: string): number {
  const packageDir = getPackageDir();
  const skillsDir = join(packageDir, "skills");
  const skills = parseSkills(skillsDir);
  if (skills.length === 0) return 0;

  const detected = detectAgents(root);
  if (detected.length === 0) return 0;

  let totalLinked = 0;
  for (const agent of detected) {
    log.info(`${agent.displayName} → ${agent.skillsDir}`);
    totalLinked += linkSkills(root, skillsDir, skills, agent.skillsDir);
  }
  return totalLinked;
}
