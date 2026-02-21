import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execSync, spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const DEV_PORT = 5199;
const DEV_BASE = `http://127.0.0.1:${DEV_PORT}`;
const PREVIEW_PORT = 5200;
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

function defineClientTests(BASE: string) {
  async function newPage(): Promise<Page> {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    return page;
  }

  async function waitForHydration(page: Page) {
    await page.waitForSelector('#app[data-hydrated="true"]');
  }

  it("hydrates without React errors", async () => {
    const page = await newPage();
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.text().includes("Hydration")) {
        errors.push(msg.text());
      }
    });

    try {
      await page.goto(BASE + "/");
      await page.waitForFunction(() =>
        document.querySelector("h1")?.textContent?.includes("Welcome"),
      );
      const text = await page.textContent("body");
      expect(text).toContain("Welcome");
      expect(errors.filter((e) => e.includes("Hydration"))).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  it("SPA navigation: home → users", async () => {
    const page = await newPage();

    try {
      await page.goto(BASE + "/");
      await waitForHydration(page);

      // Set a marker to detect if a full page reload happens
      await page.evaluate(() => {
        (window as any).__SPA_MARKER = true;
      });

      await page.click('a[href="/users"]');
      await page.waitForFunction(() =>
        document.querySelector("h1")?.textContent?.includes("Users"),
      );

      expect(page.url()).toBe(BASE + "/users");

      const marker = await page.evaluate(() => (window as any).__SPA_MARKER);
      expect(marker).toBe(true);

      const text = await page.textContent("body");
      expect(text).toContain("Alice");
      expect(text).toContain("Bob");
    } finally {
      await page.context().close();
    }
  });

  it("SPA navigation: users → user detail", async () => {
    const page = await newPage();

    try {
      await page.goto(BASE + "/users");
      await waitForHydration(page);

      await page.click('a[href="/users/1"]');
      await page.waitForFunction(() =>
        document.querySelector("h1")?.textContent?.includes("Alice"),
      );

      expect(page.url()).toBe(BASE + "/users/1");

      const text = await page.textContent("body");
      expect(text).toContain("alice@example.com");
    } finally {
      await page.context().close();
    }
  });

  it("layout persists across navigation", async () => {
    const page = await newPage();

    try {
      await page.goto(BASE + "/");
      await waitForHydration(page);

      // Stamp the nav element
      await page.evaluate(() => {
        (document.querySelector("nav") as any).__stamp = 1;
      });

      await page.click('a[href="/users"]');
      await page.waitForFunction(() =>
        document.querySelector("h1")?.textContent?.includes("Users"),
      );

      const stamp = await page.evaluate(() => (document.querySelector("nav") as any).__stamp);
      expect(stamp).toBe(1);

      const navText = await page.textContent("nav");
      expect(navText).toContain("React Pages Demo");
    } finally {
      await page.context().close();
    }
  });

  it("browser back/forward navigation", async () => {
    const page = await newPage();

    try {
      await page.goto(BASE + "/");
      await waitForHydration(page);

      await page.click('a[href="/users"]');
      await page.waitForFunction(() =>
        document.querySelector("h1")?.textContent?.includes("Users"),
      );

      await page.click('a[href="/users/1"]');
      await page.waitForFunction(() =>
        document.querySelector("h1")?.textContent?.includes("Alice"),
      );

      await page.goBack();
      await page.waitForFunction(() =>
        document.querySelector("h1")?.textContent?.includes("Users"),
      );
      expect(page.url()).toBe(BASE + "/users");

      await page.goBack();
      await page.waitForFunction(() =>
        document.querySelector("h1")?.textContent?.includes("Welcome"),
      );
      expect(page.url()).toBe(BASE + "/");

      await page.goForward();
      await page.waitForFunction(() =>
        document.querySelector("h1")?.textContent?.includes("Users"),
      );
      expect(page.url()).toBe(BASE + "/users");
    } finally {
      await page.context().close();
    }
  });

  it("form validation errors display", async () => {
    const page = await newPage();

    try {
      await page.goto(BASE + "/users");
      await waitForHydration(page);

      // Submit form without filling fields
      await page.click('button[type="submit"]');
      await page.waitForFunction(() => document.body.textContent?.includes("Name is required"));

      const text = await page.textContent("body");
      expect(text).toContain("Name is required");
      expect(text).toContain("Email is required");

      // User list should still be present (GET re-ran)
      expect(text).toContain("Alice");
      expect(text).toContain("Bob");
    } finally {
      await page.context().close();
    }
  });

  it("form submission adds user", async () => {
    const page = await newPage();

    try {
      await page.goto(BASE + "/users");
      await waitForHydration(page);

      await page.fill('input:near(:text("Name:"))', "Charlie");
      await page.fill('input:near(:text("Email:"))', "charlie@example.com");

      await page.click('button[type="submit"]');
      await page.waitForFunction(() => document.body.textContent?.includes("Charlie"));

      const text = await page.textContent("body");
      expect(text).toContain("Charlie");
      expect(text).not.toContain("Name is required");
      expect(text).not.toContain("Email is required");
      expect(page.url()).toBe(BASE + "/users");
    } finally {
      await page.context().close();
    }
  });

  it("navigate to newly added user detail", async () => {
    const page = await newPage();

    try {
      await page.goto(BASE + "/users");
      await waitForHydration(page);

      // Add a new user
      await page.fill('input:near(:text("Name:"))', "Dana");
      await page.fill('input:near(:text("Email:"))', "dana@example.com");
      await page.click('button[type="submit"]');
      await page.waitForFunction(() => document.body.textContent?.includes("Dana"));

      // Click the link to the newly added user's detail page
      await page.click('a:has-text("Dana")');
      await page.waitForFunction(() => document.querySelector("h1")?.textContent?.includes("Dana"));

      expect(page.url()).toMatch(/\/users\/\d+$/);
      const text = await page.textContent("body");
      expect(text).toContain("Dana");
      expect(text).toContain("dana@example.com");
    } finally {
      await page.context().close();
    }
  });
}

describe("react-pages client (dev)", () => {
  let child: ReturnType<typeof spawn>;
  let stderr = "";

  beforeAll(async () => {
    child = spawn(
      "pnpm",
      [
        "--dir",
        "playground/react-pages",
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

    child.stderr.on("data", (chunk: Buffer) => {
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

  defineClientTests(DEV_BASE);
}, 60_000);

describe("react-pages client (preview)", () => {
  let child: ReturnType<typeof spawn>;
  let stderr = "";

  beforeAll(async () => {
    execSync("pnpm --dir playground/react-pages build", {
      cwd: ROOT,
      stdio: "pipe",
    });

    child = spawn(
      "pnpm",
      [
        "--dir",
        "playground/react-pages",
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

    child.stderr.on("data", (chunk: Buffer) => {
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

  defineClientTests(PREVIEW_BASE);
}, 60_000);
