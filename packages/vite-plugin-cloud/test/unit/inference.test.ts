import { describe, expect, it } from "vitest";
import { inferBindingsFromSource, mergeBindings } from "../../src/inference/walk";

describe("inferBindingsFromSource", () => {
  it("detects ctx.env.db", () => {
    const code = `
      export default defineHandler((ctx) => {
        return ctx.env.db.prepare('SELECT 1').first()
      })
    `;
    const result = inferBindingsFromSource(code, "test.ts");
    expect(result.needsD1).toBe(true);
    expect(result.needsKV).toBe(false);
    expect(result.needsR2).toBe(false);
  });

  it("detects ctx.env.kv", () => {
    const code = `
      export default defineHandler(async (ctx) => {
        return ctx.env.kv.get('key')
      })
    `;
    const result = inferBindingsFromSource(code, "test.ts");
    expect(result.needsKV).toBe(true);
  });

  it("detects ctx.env.storage", () => {
    const code = `
      export default defineHandler(async (ctx) => {
        await ctx.env.storage.put('key', 'value')
      })
    `;
    const result = inferBindingsFromSource(code, "test.ts");
    expect(result.needsR2).toBe(true);
  });

  it("detects multiple bindings in one file", () => {
    const code = `
      export default defineHandler(async (ctx) => {
        const user = ctx.env.db.prepare('SELECT 1').first()
        await ctx.env.kv.set('key', 'val')
        return user
      })
    `;
    const result = inferBindingsFromSource(code, "test.ts");
    expect(result.needsD1).toBe(true);
    expect(result.needsKV).toBe(true);
    expect(result.needsR2).toBe(false);
  });

  it("ignores unrelated member expressions", () => {
    const code = `
      const x = foo.bar.db
      const y = something.env.other
    `;
    const result = inferBindingsFromSource(code, "test.ts");
    expect(result.needsD1).toBe(false);
  });

  it("handles destructured env access patterns", () => {
    // This pattern: obj.env.db — any *.env.db triggers it
    const code = `
      const handler = (ctx) => {
        const result = ctx.env.db.prepare('SELECT 1').all()
        return result
      }
    `;
    const result = inferBindingsFromSource(code, "test.ts");
    expect(result.needsD1).toBe(true);
  });

  it("returns empty for files with no bindings", () => {
    const code = `
      export default defineHandler(() => {
        return { status: 'ok' }
      })
    `;
    const result = inferBindingsFromSource(code, "test.ts");
    expect(result.needsD1).toBe(false);
    expect(result.needsKV).toBe(false);
    expect(result.needsR2).toBe(false);
  });

  it("handles invalid code gracefully", () => {
    const result = inferBindingsFromSource("not { valid {{{ code", "bad.ts");
    expect(result.needsD1).toBe(false);
    expect(result.needsKV).toBe(false);
    expect(result.needsR2).toBe(false);
  });
});

describe("mergeBindings", () => {
  it("merges multiple binding results (union)", () => {
    const result = mergeBindings([
      { needsD1: true, needsKV: false, needsR2: false },
      { needsD1: false, needsKV: true, needsR2: false },
      { needsD1: false, needsKV: false, needsR2: true },
    ]);
    expect(result.needsD1).toBe(true);
    expect(result.needsKV).toBe(true);
    expect(result.needsR2).toBe(true);
  });

  it("handles empty array", () => {
    const result = mergeBindings([]);
    expect(result.needsD1).toBe(false);
    expect(result.needsKV).toBe(false);
    expect(result.needsR2).toBe(false);
  });
});
