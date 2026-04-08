import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Collect all .sql migration files from the migrations directory,
 * sorted by filename (lexicographic order).
 */
export function collectMigrations(migrationsDir: string): { name: string; sql: string }[] {
  if (!existsSync(migrationsDir)) {
    return [];
  }

  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && f !== 'seed.sql')
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(migrationsDir, name), 'utf-8'),
    }));
}
