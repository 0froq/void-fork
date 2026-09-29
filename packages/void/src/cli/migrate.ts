import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { intro, log, outro } from '@clack/prompts';
import { join } from 'pathslash';
import { loadTypedVoidConfigFile, TYPED_CONFIG_FILE } from '../config-loader.ts';
import { validateConfig } from '../config.ts';
import { cliTitle } from './output.ts';

const LEGACY_FILE = 'void.json';
const GENERATED_MARKER = '// Generated from void.json by void migrate.';

/** Convert the legacy JSON config without rewriting an existing TypeScript config. */
export function migrateLegacyVoidConfig(root: string): boolean {
  const legacyPath = join(root, LEGACY_FILE);
  if (!existsSync(legacyPath)) {
    return false;
  }

  const raw = readFileSync(legacyPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`migrate: Invalid JSON in ${LEGACY_FILE}. Fix it before migrating.`);
  }
  validateConfig(parsed);
  const next = { ...(parsed as Record<string, unknown>) };
  delete next.$schema;

  const typedPath = join(root, TYPED_CONFIG_FILE);
  if (existsSync(typedPath)) {
    const existing = readFileSync(typedPath, 'utf8');
    if (
      existing.startsWith(GENERATED_MARKER) &&
      isDeepStrictEqual(loadTypedVoidConfigFile(typedPath), next)
    ) {
      unlinkSync(legacyPath);
      return true;
    }
    throw new Error(
      `migrate: Both ${LEGACY_FILE} and ${TYPED_CONFIG_FILE} exist. Resolve their settings before deleting either file.`,
    );
  }

  const source =
    `${GENERATED_MARKER}\n` +
    `import { defineConfig } from 'void/config';\n\n` +
    `export default defineConfig(${JSON.stringify(next, null, 2)});\n`;
  const temporaryPath = join(root, `.void.config.${randomUUID()}.ts`);
  writeFileSync(temporaryPath, source, { flag: 'wx' });
  try {
    const loaded = loadTypedVoidConfigFile(temporaryPath);
    validateConfig(loaded, TYPED_CONFIG_FILE);
    if (!isDeepStrictEqual(loaded, next)) {
      throw new Error('migrate: The typed config did not reproduce the original settings.');
    }

    const backupDir = join(root, '.void', 'config-migration');
    mkdirSync(backupDir, { recursive: true });
    const backupPath = join(backupDir, LEGACY_FILE);
    if (!existsSync(backupPath)) {
      writeFileSync(backupPath, raw, { flag: 'wx' });
    }

    if (existsSync(typedPath)) {
      throw new Error(
        `migrate: ${TYPED_CONFIG_FILE} appeared during migration. No files were removed.`,
      );
    }
    renameSync(temporaryPath, typedPath);
    try {
      unlinkSync(legacyPath);
    } catch (error) {
      rmSync(typedPath, { force: true });
      throw error;
    }
    return true;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export async function runMigrateCommand(root: string): Promise<void> {
  console.log();
  intro(cliTitle('migrate'));
  if (migrateLegacyVoidConfig(root)) {
    log.success(`Migrated ${LEGACY_FILE} to ${TYPED_CONFIG_FILE}. Commit the new config.`);
  } else {
    log.info('No legacy Void configuration found.');
  }
  outro('Configuration migration complete.');
}
