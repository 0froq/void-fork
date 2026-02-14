/**
 * Server-side validation of migration SQL for destructive operations.
 * Intentionally duplicated from CLI (~30 lines) — no shared package needed.
 */

const DESTRUCTIVE_PATTERNS = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bALTER\s+TABLE\s+\S+\s+RENAME\b/i,
];

const PRAGMA_COMMENT = "-- vite-cloud:allow-destructive";

export function validateMigrationSQL(sql: string): {
  destructive: boolean;
  allowed: boolean;
} {
  const destructive = DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(sql));
  const allowed = !destructive || sql.includes(PRAGMA_COMMENT);
  return { destructive, allowed };
}
