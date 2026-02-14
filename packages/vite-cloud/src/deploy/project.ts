import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface ProjectConfig {
  projectId: string;
  slug: string;
}

const PROJECT_FILE = "project.json";

/**
 * Read the project config from the project root.
 * Returns null if no project.json exists.
 */
export function readProjectConfig(root: string): ProjectConfig | null {
  const filePath = join(root, PROJECT_FILE);
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Write the project config to the project root.
 */
export function writeProjectConfig(root: string, config: ProjectConfig): void {
  const filePath = join(root, PROJECT_FILE);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n");
}
