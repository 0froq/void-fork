import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readProjectPaths, type ProjectPaths } from '../project-paths.ts';
import type { VoidAuthConfig } from '../runtime/auth.ts';

function isVoidAuthConfigSource(code: string): boolean {
  return /\bfrom\s+["']void\/auth["']/.test(code);
}

export function findVoidAuthConfig(
  root: string,
  paths: ProjectPaths = readProjectPaths(root),
): string | null {
  for (const absPath of paths.authConfigCandidates) {
    if (!existsSync(absPath)) {
      continue;
    }
    const code = readFileSync(absPath, 'utf-8');
    if (isVoidAuthConfigSource(code)) {
      return absPath;
    }
  }
  return null;
}

export async function loadVoidAuthConfig(
  configPath: string | null,
): Promise<VoidAuthConfig | undefined> {
  if (!configPath) {
    return undefined;
  }
  const mod = await import(pathToFileURL(configPath).href);
  return (mod.default ?? mod.auth ?? mod.config) as VoidAuthConfig | undefined;
}
