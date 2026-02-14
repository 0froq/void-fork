import { describe, expect, it } from "vitest";
import { inferBindingsFromSource, mergeBindings } from "../../src/inference/walk";

describe("inferBindingsFromSource", () => {
  it("detects c.env.DB", () => {
    const code = `
      export default defineHandler((c) => {
        return c.env.DB.prepare('SELECT 1').first()
      })
    `;
    const result = inferBindingsFromSource(code, "test.ts");
    expect(result.needsD1).toBe(true);
    expect(result.needsKV).toBe(false);
    expect(result.needsR2).toBe(false);
  });

  it("detects c.env.KV", () => {
    const code = `
      export default defineHandler(async (c) => {
        return c.env.KV.get('key')
      })
    `;
    const result = inferBindingsFromSource(code, "test.ts");
    expect(result.needsKV).toBe(true);
  });

  it("detects c.env.STORAGE", () => {
    const code = `
      export default defineHandler(async (c) => {
        await c.env.STORAGE.put('key', 'value')
      })
    `;
    const result = inferBindingsFromSource(code, "test.ts");
    expect(result.needsR2).toBe(true);
  });

  it("detects multiple bindings in one file", () => {
    const code = `
      export default defineHandler(async (c) => {
        const user = c.env.DB.prepare('SELECT 1').first()
        await c.env.KV.set('key', 'val')
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
      const x = foo.bar.DB
      const y = something.env.other
    `;
    const result = inferBindingsFromSource(code, "test.ts");
    expect(result.needsD1).toBe(false);
  });

  it("handles env access patterns", () => {
    // This pattern: obj.env.DB — any *.env.DB triggers it
    const code = `
      const handler = (c) => {
        const result = c.env.DB.prepare('SELECT 1').all()
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
