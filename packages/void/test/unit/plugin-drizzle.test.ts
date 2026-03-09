import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { drizzlePlugin } from "../../src/plugin-drizzle";

const roots: string[] = [];

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "void-drizzle-"));
  mkdirSync(join(root, "db"), { recursive: true });
  writeFileSync(join(root, "db", "schema.ts"), "export {};\n");
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("drizzlePlugin db typing generation", () => {
  it("keeps sqlite projects on the D1 internal db entry", () => {
    const root = createProjectRoot();

    drizzlePlugin(root, false, "sqlite");

    const dts = readFileSync(join(root, ".void", "db.d.ts"), "utf8");
    expect(dts).toContain('import type { DrizzleD1Database } from "void/_db";');
    expect(dts).not.toContain("void/_db-pg");
  });

  it("keeps postgres-only types off the shared db runtime entry", () => {
    const root = createProjectRoot();

    drizzlePlugin(root, false, "postgresql");

    const dts = readFileSync(join(root, ".void", "db.d.ts"), "utf8");
    expect(dts).toContain('import type { NodePgDatabase } from "void/_db-pg";');
    expect(dts).toContain('export type { NodePgDatabase } from "void/_db-pg";');
    expect(dts).toContain(
      `export { sql, eq, ne, gt, gte, lt, lte, and, or, not, desc, asc, like, ilike, notLike, inArray, notInArray, isNull, isNotNull, between, notBetween, exists, notExists, count, sum, avg, min, max } from "void/_db";`,
    );
  });
});
