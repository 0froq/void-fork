import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const DEV_PORT = 5194;
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

async function pollForResult(
  url: string,
  timeoutMs: number,
): Promise<{ found: boolean; value?: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(url);
    const body = (await res.json()) as { found: boolean; value?: string };
    if (body.found) return body;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out polling for result at ${url}`);
}

describe("playground/queues", () => {
  it("send → consumer → KV round-trip", async () => {
    const child = spawn(
      "pnpm",
      [
        "--dir",
        "playground/queues",
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
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });

    let startupError: Error | null = null;
    try {
      await waitForServer(BASE, 20_000);

      const key = `test-${Date.now()}`;
      const value = "hello";

      // Send a message to the queue
      const sendRes = await fetch(`${BASE}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      expect(sendRes.status).toBe(200);
      const sendBody = (await sendRes.json()) as { sent: boolean };
      expect(sendBody.sent).toBe(true);

      // Poll for the consumer to write the result to KV
      const result = await pollForResult(`${BASE}/api/result?key=queue-result:${key}`, 15_000);
      expect(result.found).toBe(true);
      expect(result.value).toBe(value);
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
  }, 60_000);
});
