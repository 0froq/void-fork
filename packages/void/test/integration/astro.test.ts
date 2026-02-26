import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const PLAYGROUND = "playground/astro";
const DEV_PORT = 5220;
const DEV_BASE = `http://127.0.0.1:${DEV_PORT}`;

function removeWranglerConfig(root: string) {
  rmSync(join(root, "wrangler.jsonc"), { force: true });
  rmSync(join(root, "wrangler.json"), { force: true });
}

function readWranglerConfig(root: string): {
  compatibility_flags?: string[];
  d1_databases?: Array<{ binding: string }>;
  kv_namespaces?: Array<{ binding: string }>;
} {
  const jsoncPath = join(root, "wrangler.jsonc");
  const jsonPath = join(root, "wrangler.json");
  const configPath = existsSync(jsoncPath) ? jsoncPath : jsonPath;
  return JSON.parse(readFileSync(configPath, "utf-8")) as {
    compatibility_flags?: string[];
    d1_databases?: Array<{ binding: string }>;
    kv_namespaces?: Array<{ binding: string }>;
  };
}

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
  throw new Error(`Timed out waiting for server at ${url}`);
}

async function killChild(child: ReturnType<typeof spawn>) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
}

describe("playground/astro build", () => {
  beforeAll(() => {
    const pg = join(ROOT, PLAYGROUND);
    rmSync(join(pg, "dist"), { recursive: true, force: true });
    rmSync(join(pg, ".void"), { recursive: true, force: true });
    removeWranglerConfig(pg);
    execSync(`pnpm --dir ${PLAYGROUND} build`, { cwd: ROOT, stdio: "pipe" });
  }, 120_000);

  it("produces expected build artifacts", () => {
    const workerEntry = join(ROOT, `${PLAYGROUND}/dist/server/entry.mjs`);
    expect(existsSync(workerEntry)).toBe(true);
  });
});

describe("playground/astro dev", () => {
  let child: ReturnType<typeof spawn>;
  let stderr = "";

  const startDev = async () => {
    child = spawn(
      "pnpm",
      [
        "--dir",
        PLAYGROUND,
        "exec",
        "astro",
        "dev",
        "--host",
        "127.0.0.1",
        "--port",
        String(DEV_PORT),
      ],
      {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          VOID_INSPECTOR_PORT: "false",
        },
      },
    );

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });

    await waitForServer(DEV_BASE, 20_000);
  };

  beforeAll(async () => {
    const pg = join(ROOT, PLAYGROUND);
    rmSync(join(pg, ".void"), { recursive: true, force: true });
    rmSync(join(pg, ".wrangler"), { recursive: true, force: true });
    removeWranglerConfig(pg);

    // First boot: void plugin syncs inferred bindings to wrangler.jsonc.
    await startDev();
    await killChild(child);

    // Second boot: adapter reads synced config so runtime bindings are available.
    await startDev();
  }, 60_000);

  afterAll(async () => {
    if (child) await killChild(child);
  });

  it("syncs wrangler config with compat flag and inferred bindings", () => {
    const wranglerConfig = readWranglerConfig(join(ROOT, PLAYGROUND));

    expect(wranglerConfig.compatibility_flags?.includes("nodejs_als")).toBe(true);
    expect(wranglerConfig.d1_databases?.some((b) => b.binding === "DB")).toBe(true);
    expect(wranglerConfig.kv_namespaces?.some((b) => b.binding === "KV")).toBe(true);
  });

  it("renders home page with SSR", async () => {
    const response = await fetch(`${DEV_BASE}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Astro + Void");
  });

  it("smoke route exercises D1 and KV", async () => {
    const response = await fetch(`${DEV_BASE}/smoke`);
    const html = await response.text();
    expect(response.status, html).toBe(200);
    expect(html).toMatch(/<span[^>]*data-testid="d1-user"[^>]*>Alice<\/span>/);
    expect(html).toMatch(/<span[^>]*data-testid="kv-value"[^>]*>ok<\/span>/);
  });
}, 60_000);
