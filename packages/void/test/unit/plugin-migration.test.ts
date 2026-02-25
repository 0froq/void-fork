import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrationPlugin } from "../../src/plugin-migration";
import { getMiniflareDatabasePath } from "../../src/migrations/runner";

const roots: string[] = [];

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "void-migrations-"));
  const migrationsDir = join(root, "migrations");
  mkdirSync(migrationsDir, { recursive: true });
  writeFileSync(
    join(migrationsDir, "001_create_users.sql"),
    "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
  );
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("migrationPlugin persistence roots", () => {
  it("uses .void by default", async () => {
    const root = createProjectRoot();
    const plugin = migrationPlugin(root);

    await plugin.configureServer?.({} as any);

    const dbPath = getMiniflareDatabasePath(join(root, ".void"), "local");
    expect(existsSync(dbPath)).toBe(true);
  });

  it("supports custom persist root for framework mode", async () => {
    const root = createProjectRoot();
    const persistRoot = join(root, ".wrangler", "state");
    const plugin = migrationPlugin(root, "local", persistRoot);

    await plugin.configureServer?.({} as any);

    const dbPath = getMiniflareDatabasePath(persistRoot, "local");
    expect(existsSync(dbPath)).toBe(true);
  });
});
