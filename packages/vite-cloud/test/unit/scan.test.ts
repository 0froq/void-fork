import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { scanRoutes } from "../../src/router/scan";

const TMP = join(import.meta.dirname, "__tmp_scan_test__");

function createFile(path: string, content = "export default () => {}") {
  const full = join(TMP, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

describe("scanRoutes", () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("discovers route files", async () => {
    createFile("routes/api/hello.get.ts");
    createFile("routes/api/users/index.ts");

    const result = await scanRoutes(TMP);
    expect(result.routes).toHaveLength(2);
    expect(result.routes.map((r) => r.pattern)).toContain("/api/hello");
    expect(result.routes.map((r) => r.pattern)).toContain("/api/users");
  });

  it("ignores files starting with _", async () => {
    createFile("routes/api/hello.ts");
    createFile("routes/api/_utils.ts");

    const result = await scanRoutes(TMP);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].pattern).toBe("/api/hello");
  });

  it("discovers and sorts middleware by numeric prefix", async () => {
    createFile("middleware/02.auth.ts");
    createFile("middleware/01.logger.ts");

    const result = await scanRoutes(TMP);
    expect(result.middleware).toHaveLength(2);
    expect(result.middleware[0].order).toBe(1);
    expect(result.middleware[1].order).toBe(2);
  });

  it("handles missing middleware directory", async () => {
    createFile("routes/hello.ts");
    // No middleware/ directory

    const result = await scanRoutes(TMP);
    expect(result.middleware).toEqual([]);
    expect(result.routes).toHaveLength(1);
  });

  it("sorts catch-all routes last", async () => {
    createFile("routes/[...].ts");
    createFile("routes/api/hello.ts");

    const result = await scanRoutes(TMP);
    expect(result.routes[0].pattern).toBe("/api/hello");
    expect(result.routes[1].pattern).toBe("/**");
  });
});
