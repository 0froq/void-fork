import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { intro, outro, log } from "@clack/prompts";
import { getToken } from "./auth";
import { PlatformClient } from "./client";
import { readProjectConfig } from "./project";
import type { DbArgs } from "./db-args";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

export async function runDbCommand(root: string, args: DbArgs): Promise<void> {
  console.log();
  intro("\x1b[34mvite-cloud db\x1b[0m");

  if (args.action === "status") {
    await runStatus(root);
  } else if (args.action === "reset") {
    await runReset(root);
  } else {
    await runSeed(root, args.file);
  }
}

async function runStatus(root: string): Promise<void> {
  const migrationsDir = join(root, "migrations");
  const { collectMigrations } = await import("../migrations/collect");
  const allMigrations = collectMigrations(migrationsDir);

  if (allMigrations.length === 0) {
    log.info("No migration files found in migrations/");
    outro("");
    return;
  }

  const { getMiniflareDatabasePath, getAppliedMigrations } = await import("../migrations/runner");
  const persistRoot = join(root, ".vite-cloud");
  const dbPath = getMiniflareDatabasePath(persistRoot, "local");
  const localApplied = await getAppliedMigrations(dbPath);
  const localSet = new Set(localApplied.map((m) => m.name));

  // Try to get remote status
  let remoteApplied: { name: string; applied_at: string }[] | null = null;
  const token = getToken();
  const config = readProjectConfig(root);
  if (token && config) {
    try {
      const client = new PlatformClient(token);
      const result = await client.getMigrationStatus(config.projectId);
      remoteApplied = result.applied;
    } catch {
      // graceful degradation — remote unavailable
    }
  }

  const remoteSet = remoteApplied ? new Set(remoteApplied.map((m) => m.name)) : null;

  const lines: string[] = [];
  for (const migration of allMigrations) {
    const localStatus = localSet.has(migration.name)
      ? `${GREEN}applied${RESET}`
      : `${YELLOW}pending${RESET}`;

    let remotePart = "";
    if (remoteSet !== null) {
      const remoteStatus = remoteSet.has(migration.name)
        ? `${GREEN}applied${RESET}`
        : `${YELLOW}pending${RESET}`;
      remotePart = `  remote: ${remoteStatus}`;
    }

    lines.push(`  ${migration.name}  ${DIM}local:${RESET} ${localStatus}${remotePart}`);
  }

  log.info(lines.join("\n"));

  const localPending = allMigrations.length - localSet.size;
  const parts = [`${allMigrations.length} migration(s)`];
  if (localPending > 0) {
    parts.push(`${localPending} pending locally`);
  }
  if (remoteSet !== null) {
    const remotePending = allMigrations.length - remoteSet.size;
    if (remotePending > 0) {
      parts.push(`${remotePending} pending remotely`);
    }
  }
  outro(parts.join(", "));
}

async function runReset(root: string): Promise<void> {
  const { getMiniflareDatabasePath, runMigrations } = await import("../migrations/runner");
  const persistRoot = join(root, ".vite-cloud");
  const dbPath = getMiniflareDatabasePath(persistRoot, "local");

  // Delete database files
  rmSync(dbPath, { force: true });
  rmSync(dbPath + "-wal", { force: true });
  rmSync(dbPath + "-shm", { force: true });

  const migrationsDir = join(root, "migrations");
  const applied = await runMigrations(migrationsDir, dbPath);
  log.success(`Database reset. Applied ${applied.length} migration(s).`);
  log.info(`${DIM}Restart your dev server if it's running.${RESET}`);
  outro("");
}

async function runSeed(root: string, file?: string): Promise<void> {
  // Reset first
  const { getMiniflareDatabasePath, runMigrations } = await import("../migrations/runner");
  const persistRoot = join(root, ".vite-cloud");
  const dbPath = getMiniflareDatabasePath(persistRoot, "local");

  rmSync(dbPath, { force: true });
  rmSync(dbPath + "-wal", { force: true });
  rmSync(dbPath + "-shm", { force: true });

  const migrationsDir = join(root, "migrations");
  const applied = await runMigrations(migrationsDir, dbPath);
  log.step(`Applied ${applied.length} migration(s).`);

  // Run seed
  const seedPath = file ? join(root, file) : join(migrationsDir, "seed.sql");
  if (!existsSync(seedPath)) {
    log.error(`Seed file not found: ${seedPath}`);
    process.exit(1);
  }

  const sql = readFileSync(seedPath, "utf-8");
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(dbPath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }

  log.success(`Seeded from ${file ?? "migrations/seed.sql"}.`);
  log.info(`${DIM}Restart your dev server if it's running.${RESET}`);
  outro("");
}
