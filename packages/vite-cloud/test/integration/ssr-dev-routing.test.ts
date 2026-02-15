import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const DEV_PORT = 5191;
const BASE = `http://127.0.0.1:${DEV_PORT}`;

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
  throw new Error(`Timed out waiting for dev server at ${url}`);
}

describe("playground/ssr dev routing", () => {
  it(
    "serves SSR output for / and non-root paths",
    async () => {
      const child = spawn(
        "pnpm",
        [
          "--dir",
          "playground/ssr",
          "exec",
          "vite",
          "--host",
          "127.0.0.1",
          "--port",
          String(DEV_PORT),
          "--strictPort",
        ],
        {
          cwd: ROOT,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            VITE_CLOUD_INSPECTOR_PORT: "false",
          },
        },
      );

      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });

      let startupError: Error | null = null;
      try {
        await waitForServer(BASE, 20_000);

        const rootResponse = await fetch(`${BASE}/`);
        expect(rootResponse.status).toBe(200);
        const rootHtml = await rootResponse.text();
        expect(rootHtml).toContain("Vite Cloud SSR Playground");
        expect(rootHtml).toContain("Rendered URL: <!-- -->/");

        const nestedResponse = await fetch(`${BASE}/dashboard`);
        expect(nestedResponse.status).toBe(200);
        const nestedHtml = await nestedResponse.text();
        expect(nestedHtml).toContain("Rendered URL: <!-- -->/dashboard");
      } catch (err) {
        startupError = err instanceof Error ? err : new Error(String(err));
      } finally {
        child.kill("SIGTERM");
        await once(child, "exit");
      }

      if (stderr.includes("error when starting dev server")) {
        throw new Error(stderr);
      }
      if (startupError) {
        throw startupError;
      }
    },
    30_000,
  );
});
