import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");

describe("playground/ssr build", () => {
  it("builds and emits worker bundle with SSR fallback", () => {
    execSync("pnpm --dir playground/ssr build", { cwd: ROOT, stdio: "pipe" });

    const workerEntry = join(ROOT, "playground/ssr/dist/playground_ssr/index.js");
    const clientManifest = join(ROOT, "playground/ssr/dist/client/.vite/manifest.json");
    const clientIndexHtml = join(ROOT, "playground/ssr/dist/client/index.html");

    expect(existsSync(workerEntry)).toBe(true);
    expect(existsSync(clientManifest)).toBe(true);
    expect(existsSync(clientIndexHtml)).toBe(false);

    const code = readFileSync(workerEntry, "utf-8");
    expect(code).toContain("renderSsrResponse(c, mod)");
    expect(code).toContain('new URL("/.vite/manifest.json", request.url)');
    expect(code).toContain('SSR_CLIENT_ENTRY_ID = "src/client.entry.tsx"');

    const wranglerConfig = JSON.parse(
      readFileSync(join(ROOT, "playground/ssr/dist/playground_ssr/wrangler.json"), "utf-8"),
    ) as {
      assets?: { run_worker_first?: boolean | string[] };
      kv_namespaces?: Array<{ binding: string }>;
    };
    expect(wranglerConfig.assets?.run_worker_first).toEqual([
      "/**",
      "!/@*",
      "!/src/*",
      "!/node_modules/*",
    ]);
    expect(wranglerConfig.kv_namespaces?.some((b) => b.binding === "KV")).toBe(true);
  });
});
