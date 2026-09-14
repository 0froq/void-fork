import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'pathslash';

export type PlatformRuntimeManifest = Readonly<{
  artifacts: Readonly<
    Record<
      'api' | 'dispatch' | 'proxy' | 'tail',
      Readonly<{
        path: string;
        sha256: string;
        size: number;
      }>
    >
  >;
  platformVersion: string;
  schemaVersion: 1;
}>;

export function getPlatformRuntimeDirectory(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'runtime');
}

export function readPlatformRuntimeManifest(): PlatformRuntimeManifest {
  const path = join(getPlatformRuntimeDirectory(), 'manifest.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PlatformRuntimeManifest;
  } catch (error) {
    throw new Error(
      `Void Platform deployment artifacts are missing or invalid at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
