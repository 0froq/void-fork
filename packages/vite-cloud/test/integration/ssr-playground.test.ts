import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");

describe("playground/ssr build", () => {
  it("builds and emits worker bundle with SSR fallback", () => {
    execSync("pnpm --dir playground/ssr build", { cwd: ROOT, stdio: "pipe" });

    const workerEntry = join(ROOT, "playground/ssr/dist/playground_ssr/index.js");
    const clientHtml = join(ROOT, "playground/ssr/dist/client/index.html");

    expect(existsSync(workerEntry)).toBe(true);
    expect(existsSync(clientHtml)).toBe(true);

    const code = readFileSync(workerEntry, "utf-8");
    expect(code).toContain("mod.render(c.req.raw, c.env)");

    const wranglerConfig = JSON.parse(
      readFileSync(join(ROOT, "playground/ssr/dist/playground_ssr/wrangler.json"), "utf-8"),
    ) as {
      assets?: { run_worker_first?: boolean };
      kv_namespaces?: Array<{ binding: string }>;
    };
    expect(wranglerConfig.assets?.run_worker_first).toBe(true);
    expect(wranglerConfig.kv_namespaces?.some((b) => b.binding === "KV")).toBe(true);
  });
});
