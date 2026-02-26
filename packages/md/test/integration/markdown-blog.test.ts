import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execSync, spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const DEV_PORT = 5221;
const DEV_BASE = `http://127.0.0.1:${DEV_PORT}`;
const PREVIEW_PORT = 5222;
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
  throw new Error(`Timed out waiting for server at ${url}`);
}

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

async function newPage(): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  return page;
}

function defineSidebarTests(BASE: string) {
  it("renders sidebar with post links", async () => {
    const page = await newPage();
    try {
      await page.goto(`${BASE}/posts/getting-started`);
      await page.waitForSelector("aside");

      const links = await page.$$eval("aside a", (els) =>
        els.map((a) => ({ text: a.textContent?.trim(), href: a.getAttribute("href") })),
      );

      const texts = links.map((l) => l.text);
      expect(texts).toContain("Getting Started");
      expect(texts).toContain("Code Examples");

      const hrefs = links.map((l) => l.href);
      expect(hrefs).toContain("/posts/getting-started");
      expect(hrefs).toContain("/posts/code-examples");
    } finally {
      await page.context().close();
    }
  });

  it("navigates between posts via sidebar", async () => {
    const page = await newPage();
    try {
      await page.goto(`${BASE}/posts/getting-started`);
      await page.waitForSelector("aside");

      // Click the "Code Examples" link in the sidebar
      await page.click('aside a[href="/posts/code-examples"]');
      await page.waitForSelector("h1");

      expect(page.url()).toContain("/posts/code-examples");
      const heading = await page.textContent("h1");
      expect(heading).toContain("Code Examples");
    } finally {
      await page.context().close();
    }
  });

  it("blog index lists all posts", async () => {
    const page = await newPage();
    try {
      await page.goto(`${BASE}/`);
      await page.waitForSelector("h1");

      const body = await page.textContent("body");
      expect(body).toContain("Getting Started");
      expect(body).toContain("Code Examples");
      expect(body).toContain("Learn how to use Void");
      expect(body).toContain("Shiki syntax highlighting demos");
    } finally {
      await page.context().close();
    }
  });
}

describe("markdown-blog playground", () => {
  describe("dev", () => {
    let child: ReturnType<typeof spawn>;
    let stderr = "";

    beforeAll(async () => {
      child = spawn(
        "pnpm",
        [
          "--dir",
          "playground/markdown-blog",
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
      if (child) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          await Promise.race([
            once(child, "exit"),
            new Promise((resolve) => setTimeout(resolve, 5_000)),
          ]);
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }
      }
      if (stderr.includes("error when starting dev server")) {
        throw new Error(stderr);
      }
    });

    it("injects style for @void-x/md/theme in dev mode", async () => {
      const res = await fetch(`${DEV_BASE}/posts/getting-started`);
      expect(res.status).toBe(200);
      const html = await res.text();

      // Dev mode includes Vite client
      expect(html).toContain("/@vite/client");

      // Theme CSS is injected (either inline <style> or CSS link referencing md/theme)
      const hasThemeStyle =
        html.includes("void-md") || html.includes("md/theme") || html.includes("md/dist/theme");
      expect(hasThemeStyle).toBe(true);
    });

    it("renders markdown content correctly", async () => {
      const res = await fetch(`${DEV_BASE}/posts/getting-started`);
      expect(res.status).toBe(200);
      const html = await res.text();

      // Rendered heading
      expect(html).toContain("Getting Started");

      // Container blocks (tip/warning custom blocks)
      expect(html).toMatch(/custom-block|tip|warning/);

      // Code blocks with Shiki highlighting
      expect(html).toContain("<pre");
      expect(html).toContain("<code");
      expect(html).toContain("<span");
    });

    defineSidebarTests(DEV_BASE);
  }, 60_000);

  describe("production (build + preview)", () => {
    let child: ReturnType<typeof spawn>;
    let stderr = "";

    beforeAll(async () => {
      execSync("pnpm --dir playground/markdown-blog build", {
        cwd: ROOT,
        stdio: "pipe",
      });

      child = spawn(
        "pnpm",
        [
          "--dir",
          "playground/markdown-blog",
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

      child.stderr!.on("data", (chunk: Buffer) => {
        stderr += String(chunk);
      });

      await waitForServer(PREVIEW_BASE, 20_000);
    });

    afterAll(async () => {
      if (child) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          await Promise.race([
            once(child, "exit"),
            new Promise((resolve) => setTimeout(resolve, 5_000)),
          ]);
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }
      }
      if (stderr.includes("error when starting preview server")) {
        throw new Error(stderr);
      }
    });

    it("serves pre-rendered markdown pages", async () => {
      const res = await fetch(`${PREVIEW_BASE}/posts/getting-started`);
      expect(res.status).toBe(200);
      const html = await res.text();

      // Contains rendered markdown content
      expect(html).toContain("Getting Started");
      expect(html).toContain("<pre");

      // No Vite client script in production
      expect(html).not.toContain("/@vite/client");
    });

    it("includes theme styles", async () => {
      const res = await fetch(`${PREVIEW_BASE}/posts/getting-started`);
      const html = await res.text();

      // Production should have theme CSS inlined or as a linked stylesheet
      const hasThemeCSS =
        html.includes("void-md") || html.includes("<link") || html.includes("<style");
      expect(hasThemeCSS).toBe(true);
    });

    defineSidebarTests(PREVIEW_BASE);
  }, 60_000);
}, 60_000);
