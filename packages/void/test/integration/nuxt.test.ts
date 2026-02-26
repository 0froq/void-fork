import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const PLAYGROUND = "playground/nuxt";
const DEV_PORT = 5219;
const DEV_BASE = `http://127.0.0.1:${DEV_PORT}`;

function removeWranglerConfig(root: string) {
  rmSync(join(root, "wrangler.jsonc"), { force: true });
  rmSync(join(root, "wrangler.json"), { force: true });
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

describe("playground/nuxt build", () => {
  beforeAll(() => {
    const pg = join(ROOT, PLAYGROUND);
    rmSync(join(pg, ".output"), { recursive: true, force: true });
    rmSync(join(pg, ".nuxt"), { recursive: true, force: true });
    rmSync(join(pg, ".void"), { recursive: true, force: true });
    removeWranglerConfig(pg);
    execSync(`pnpm --dir ${PLAYGROUND} build`, { cwd: ROOT, stdio: "pipe" });
  }, 120_000);

  it("produces expected build artifacts", () => {
    const serverEntry = join(ROOT, `${PLAYGROUND}/.output/server/index.mjs`);
    expect(existsSync(serverEntry)).toBe(true);

    const publicDir = join(ROOT, `${PLAYGROUND}/.output/public`);
    expect(existsSync(publicDir)).toBe(true);
  });
});

describe("playground/nuxt dev", () => {
  let child: ReturnType<typeof spawn>;
  let stderr = "";

  beforeAll(async () => {
    const pg = join(ROOT, PLAYGROUND);
    rmSync(join(pg, ".void"), { recursive: true, force: true });
    rmSync(join(pg, ".wrangler"), { recursive: true, force: true });
    removeWranglerConfig(pg);

    child = spawn(
      "pnpm",
      [
        "--dir",
        PLAYGROUND,
        "exec",
        "nuxt",
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

    await waitForServer(DEV_BASE, 30_000);
  }, 45_000);

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
    expect(html).toContain("Nuxt + Void");
  });

  it("smoke API returns D1 and KV data", async () => {
    const response = await fetch(`${DEV_BASE}/api/smoke`);
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      user: { name: string } | null;
      kvValue: string | null;
    };
    expect(data.user?.name).toBe("Alice");
    expect(data.kvValue).toBe("ok");
  });
}, 60_000);
