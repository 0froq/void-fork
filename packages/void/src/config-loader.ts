import { existsSync, readFileSync } from 'node:fs';
import { createJiti } from 'jiti';
import { join } from 'pathslash';

export const LEGACY_CONFIG_FILE = 'void.json';
export const TYPED_CONFIG_FILE = 'void.config.ts';

export type LoadedVoidConfig = { source: string; value: unknown };

/** Load project-authored configuration before runtime validation. */
export function loadVoidConfig(root: string): LoadedVoidConfig | null {
  const typedPath = join(root, TYPED_CONFIG_FILE);
  const jsonPath = join(root, LEGACY_CONFIG_FILE);
  const hasTyped = existsSync(typedPath);
  const hasJson = existsSync(jsonPath);
  if (hasTyped && hasJson) {
    throw new Error(
      `config: Found both ${TYPED_CONFIG_FILE} and ${LEGACY_CONFIG_FILE}. Keep one source of truth.`,
    );
  }
  if (!hasTyped && !hasJson) {
    return null;
  }

  if (hasTyped) {
    try {
      const jiti = createJiti(import.meta.url, {
        fsCache: false,
        moduleCache: false,
        interopDefault: false,
      });
      const module = jiti(typedPath) as { default?: unknown };
      if (!Object.hasOwn(module, 'default')) {
        throw new Error('expected a default export');
      }
      return { source: TYPED_CONFIG_FILE, value: module.default };
    } catch (error) {
      throw new Error(
        `config: Could not load ${TYPED_CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  try {
    return { source: LEGACY_CONFIG_FILE, value: JSON.parse(readFileSync(jsonPath, 'utf-8')) };
  } catch {
    throw new Error(`config: Invalid JSON in ${LEGACY_CONFIG_FILE}.`);
  }
}
