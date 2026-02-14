import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

/**
 * Vite plugin that runs local D1 migrations on dev server startup.
 * Applies unapplied .sql files from the migrations/ directory
 * to the local SQLite database.
 */
export function migrationPlugin(root: string): Plugin {
  return {
    name: "vite-cloud:migrations",
    apply: "serve",

    async configureServer() {
      const migrationsDir = join(root, "migrations");
      if (!existsSync(migrationsDir)) return;

      const dbPath = join(root, ".vite-cloud", "d1", "local.db");

      try {
        const { runMigrations } = await import("./migrations/runner");
        const applied = await runMigrations(migrationsDir, dbPath);
        if (applied.length > 0) {
          console.log(`[vite-cloud] Applied ${applied.length} migration(s): ${applied.join(", ")}`);
        }
      } catch (err) {
        console.error("[vite-cloud] Migration error:", err);
      }
    },
  };
}
