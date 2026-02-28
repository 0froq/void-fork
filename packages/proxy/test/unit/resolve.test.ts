import { describe, it, expect, vi } from "vitest";
import { resolveResource } from "../../src/resolve";

function createMockDb(rows: Record<string, { cf_id: string }>) {
  return {
    prepare: vi.fn((_sql: string) => ({
      bind: vi.fn((...args: unknown[]) => ({
        first: vi.fn(async () => {
          const key = args.join(":");
          return rows[key] ?? null;
        }),
      })),
    })),
  } as unknown as D1Database;
}

describe("resolveResource", () => {
  it("returns cf_id for a known resource", async () => {
    const db = createMockDb({ "proj_1:d1:DB": { cf_id: "d1-uuid-123" } });
    const result = await resolveResource(db, "proj_1", "d1", "DB");
    expect(result).toBe("d1-uuid-123");
  });

  it("throws for an unknown resource", async () => {
    const db = createMockDb({});
    await expect(resolveResource(db, "proj_1", "kv", "MISSING")).rejects.toThrow(
      'No kv resource "MISSING" found for project proj_1',
    );
  });

  it("queries with correct parameters", async () => {
    const db = createMockDb({ "proj_42:r2:STORAGE": { cf_id: "r2-uuid-456" } });
    await resolveResource(db, "proj_42", "r2", "STORAGE");

    expect(db.prepare).toHaveBeenCalledWith(
      "SELECT cf_id FROM resources WHERE project_id = ? AND type = ? AND binding_name = ?",
    );
  });
});
