import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const PLAYGROUND = "playground/astro";
const DEV_PORT = 5220;
const DEV_BASE = `http://127.0.0.1:${DEV_PORT}`;

const MINIMAL_WRANGLER = JSON.stringify(
  { name: "playground-astro", compatibility_date: "2026-02-24" },
  null,
  2,
);

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
    writeFileSync(join(pg, "wrangler.jsonc"), MINIMAL_WRANGLER);
    execSync(`pnpm --dir ${PLAYGROUND} build`, { cwd: ROOT, stdio: "pipe" });
  }, 120_000);

  it("produces expected build artifacts", () => {
    const workerEntry = join(ROOT, `${PLAYGROUND}/dist/_worker.js/index.js`);
    expect(existsSync(workerEntry)).toBe(true);
  });
});

describe("playground/astro dev", () => {
  let child: ReturnType<typeof spawn>;
  let stderr = "";

  beforeAll(async () => {
    const pg = join(ROOT, PLAYGROUND);
    rmSync(join(pg, ".void"), { recursive: true, force: true });
    rmSync(join(pg, ".wrangler"), { recursive: true, force: true });
    writeFileSync(join(pg, "wrangler.jsonc"), MINIMAL_WRANGLER);

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
  }, 30_000);

  afterAll(async () => {
    if (child) await killChild(child);
  });

  it("syncs wrangler.jsonc with bindings from void.json", () => {
    const wranglerConfig = JSON.parse(
      readFileSync(join(ROOT, `${PLAYGROUND}/wrangler.jsonc`), "utf-8"),
    ) as {
      d1_databases?: Array<{ binding: string }>;
      kv_namespaces?: Array<{ binding: string }>;
    };

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
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Alice");
    expect(html).toContain("ok");
  });
}, 60_000);
