import { createHash, createHmac } from "node:crypto";
import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface AppliedMigration {
  name: string;
  applied_at: string;
}

/**
 * Read the list of applied migrations from the local SQLite database.
 * Returns [] if the DB file or _migrations table doesn't exist.
 */
export async function getAppliedMigrations(dbPath: string): Promise<AppliedMigration[]> {
  if (!existsSync(dbPath)) {
    return [];
  }

  const Database = (await import("better-sqlite3")).default;
  const db = new Database(dbPath, { readonly: true });

  try {
    // Check if _migrations table exists
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
      .get();

    if (!tableExists) {
      return [];
    }

    return db
      .prepare("SELECT name, applied_at FROM _migrations ORDER BY name")
      .all() as AppliedMigration[];
  } finally {
    db.close();
  }
}

/**
 * Compute the miniflare D1 SQLite database path.
 * Miniflare uses a deterministic hash based on the database_id
 * to store local D1 data.
 */
export function getMiniflareDatabasePath(persistRoot: string, databaseId: string): string {
  const uniqueKey = "miniflare-D1DatabaseObject";

  // Step 1: SHA-256 of the unique key
  const key = createHash("sha256").update(uniqueKey).digest();

  // Step 2: HMAC-SHA-256 of database_id, take first 16 bytes
  const nameHmac = createHmac("sha256", key).update(databaseId).digest().subarray(0, 16);

  // Step 3: HMAC-SHA-256 of nameHmac, take first 16 bytes
  const hmac = createHmac("sha256", key).update(nameHmac).digest().subarray(0, 16);

  // Step 4: Concatenate to get the filename hash
  const hash = Buffer.concat([nameHmac, hmac]).toString("hex");

  return join(persistRoot, "v3", "d1", uniqueKey, `${hash}.sqlite`);
}

/**
 * Apply unapplied SQL migrations from the migrations directory to a local SQLite database.
 * Uses better-sqlite3 to access the SQLite file directly.
 *
 * Tracks applied migrations in a _migrations table:
 *   CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT)
 */
export async function runMigrations(migrationsDir: string, dbPath: string): Promise<string[]> {
  if (!existsSync(migrationsDir)) {
    return [];
  }

  // Dynamically import better-sqlite3 (dev-only dependency)
  const Database = (await import("better-sqlite3")).default;

  // Ensure the directory for the database exists
  const dbDir = join(dbPath, "..");
  mkdirSync(dbDir, { recursive: true });

  const db = new Database(dbPath);

  try {
    // Create migrations tracking table if it doesn't exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);

    // Get already-applied migrations
    const applied = new Set(
      db
        .prepare("SELECT name FROM _migrations")
        .all()
        .map((row: any) => row.name),
    );

    // Read migration files, sorted by name
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const newlyApplied: string[] = [];

    for (const file of files) {
      if (applied.has(file)) continue;

      const sql = readFileSync(join(migrationsDir, file), "utf-8");

      // Run migration in a transaction
      const transaction = db.transaction(() => {
        db.exec(sql);
        db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(
          file,
          new Date().toISOString(),
        );
      });

      transaction();
      newlyApplied.push(file);
    }

    return newlyApplied;
  } finally {
    db.close();
  }
}
