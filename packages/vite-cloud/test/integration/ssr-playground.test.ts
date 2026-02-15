import { describe, expect, it } from "vitest";
import { execSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const PREVIEW_PORT = 5192;
const PREVIEW_BASE = `http://127.0.0.1:${PREVIEW_PORT}`;

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.status > 0) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for preview server at ${url}`);
}

describe("playground/ssr build", () => {
  it("builds, emits prerendered HTML, and preview serves prerendered pages", async () => {
    rmSync(join(ROOT, "playground/ssr/dist"), { recursive: true, force: true });
    execSync("pnpm --dir playground/ssr build", { cwd: ROOT, stdio: "pipe" });

    const workerEntry = join(ROOT, "playground/ssr/dist/playground_ssr/index.js");
    const clientManifest = join(ROOT, "playground/ssr/dist/client/.vite/manifest.json");
    const clientIndexHtml = join(ROOT, "playground/ssr/dist/client/index.html");
    const clientAboutHtml = join(ROOT, "playground/ssr/dist/client/about/index.html");

    expect(existsSync(workerEntry)).toBe(true);
    expect(existsSync(clientManifest)).toBe(true);
    expect(existsSync(clientIndexHtml)).toBe(true);
    expect(existsSync(clientAboutHtml)).toBe(true);
    expect(statSync(clientIndexHtml).isFile()).toBe(true);
    expect(statSync(clientAboutHtml).isFile()).toBe(true);

    const code = readFileSync(workerEntry, "utf-8");
    expect(code).toContain("renderSsrResponse(c, mod)");
    expect(code).toContain('new URL("/.vite/manifest.json", request.url)');
    expect(code).toContain('SSR_CLIENT_ENTRY_ID = "src/main.client.tsx"');

    const aboutHtml = readFileSync(clientAboutHtml, "utf-8");
    expect(readFileSync(clientIndexHtml, "utf-8")).toContain("Rendered URL: <!-- -->/");
    expect(aboutHtml).toContain("Rendered URL: <!-- -->/about");

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

    const child = spawn(
      "pnpm",
      [
        "--dir",
        "playground/ssr",
        "exec",
        "vite",
        "preview",
        "--host",
        "127.0.0.1",
        "--port",
        String(PREVIEW_PORT),
        "--strictPort",
      ],
      {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    let startupError: Error | null = null;
    try {
      await waitForServer(PREVIEW_BASE, 20_000);

      const rootFirst = await (await fetch(`${PREVIEW_BASE}/`)).text();
      const rootSecond = await (await fetch(`${PREVIEW_BASE}/`)).text();
      expect(rootFirst).toContain("Rendered URL: <!-- -->/");
      expect(rootSecond).toContain("Rendered URL: <!-- -->/");
      expect(rootFirst).toContain("KV visit count: <!-- -->1");
      expect(rootSecond).toContain("KV visit count: <!-- -->1");

      const previewAboutHtml = await (await fetch(`${PREVIEW_BASE}/about`)).text();
      expect(previewAboutHtml).toContain("Rendered URL: <!-- -->/about");
      expect(previewAboutHtml).toContain("KV visit count: <!-- -->2");
    } catch (err) {
      startupError = err instanceof Error ? err : new Error(String(err));
    } finally {
      child.kill("SIGTERM");
      await once(child, "exit");
    }

    if (stderr.includes("error when starting preview server")) {
      throw new Error(stderr);
    }
    if (startupError) {
      throw startupError;
    }
  }, 60_000);
});
