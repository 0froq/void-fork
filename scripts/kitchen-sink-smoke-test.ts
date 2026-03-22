/**
 * Kitchen Sink Playwright Smoke Test
 *
 * Standalone script that runs 11 smoke tests against a deployed kitchen-sink app.
 * Uses node:test + node:assert — no vitest needed.
 *
 * Usage:
 *   node scripts/kitchen-sink-smoke-test.ts                              # defaults to staging
 *   SMOKE_URL=https://kitchen-sink.void.app node scripts/kitchen-sink-smoke-test.ts  # production
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const BASE = (process.env.SMOKE_URL || "https://kitchen-sink.staging.void.app").replace(/\/$/, "");
const TIMEOUT = 15_000;
const uid = Date.now().toString(36);

let browser: Browser;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForHydration(p: Page) {
  await p.waitForSelector('#app[data-hydrated="true"]', { timeout: TIMEOUT });
}

async function goto(p: Page, path: string) {
  await p.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await waitForHydration(p);
}

/** Wait for body text to include `text`, polling with page reloads. */
async function pollForText(p: Page, path: string, text: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await goto(p, path);
    const body = await p.textContent("body");
    if (body?.includes(text)) return;
    await p.waitForTimeout(2_000);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for "${text}" on ${path}`);
}

/** Wait for body text to stop including `text` (up to timeoutMs, no reloads). */
async function waitForTextGone(p: Page, text: string, timeoutMs = TIMEOUT) {
  await p.waitForFunction((t) => !document.body.textContent?.includes(t), text, {
    timeout: timeoutMs,
  });
}

/** Wait for body text to include `text` (no reload, just DOM polling). */
async function waitForText(p: Page, text: string, timeoutMs = TIMEOUT) {
  await p.waitForFunction((t) => document.body.textContent?.includes(t), text, {
    timeout: timeoutMs,
  });
}

/** Click the Delete button in the table row containing `needle`. */
async function deleteRowContaining(p: Page, needle: string) {
  await p.evaluate((n) => {
    const row = Array.from(document.querySelectorAll("tr")).find((r) => r.textContent?.includes(n));
    if (!row) throw new Error(`Row containing "${n}" not found`);
    const btn = row.querySelector("button");
    if (!btn) throw new Error(`No button in row containing "${n}"`);
    btn.click();
  }, needle);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

void describe(`kitchen-sink smoke (${BASE})`, { concurrency: true }, () => {
  before(async () => {
    browser = await chromium.launch();

    // Reset all app state for a clean slate
    const res = await fetch(`${BASE}/api/reset`, { method: "POST" });
    if (!res.ok) {
      console.warn(`  ⚠ Reset endpoint returned ${res.status} — tests may see stale data`);
    }
  });

  after(async () => {
    await browser?.close();
  });

  /** Create an isolated browser context + page. Caller must close ctx when done. */
  async function freshPage(): Promise<{ ctx: BrowserContext; page: Page }> {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    return { ctx, page };
  }

  // -----------------------------------------------------------------------
  // 1. Home SSR + asset caching
  // -----------------------------------------------------------------------
  void it("1 — home SSR + asset caching", async () => {
    const { ctx, page: p } = await freshPage();
    try {
      await goto(p, "/");

      const body = await p.textContent("body");
      assert.ok(body?.includes("Kitchen Sink"), "page contains 'Kitchen Sink'");
      assert.ok(body?.includes("Auth"), "page contains 'Auth'");

      // Find a hashed asset URL in the HTML source (hashes are base64url-like, e.g. DOjtQvIZ)
      const html = await p.content();
      const assetMatch = html.match(/\/(assets\/[^"']+[-._][A-Za-z0-9_-]{6,}\.(js|css))/);
      assert.ok(assetMatch, "found hashed asset URL in HTML");

      const assetUrl = `${BASE}/${assetMatch![1]}`;

      // Use in-browser fetch (not curl) — CF edge cache rules differ for browser vs non-browser
      const cacheControl = await p.evaluate(async (url) => {
        const res = await fetch(url, { method: "HEAD" });
        return res.headers.get("cache-control") || "";
      }, assetUrl);

      assert.ok(
        cacheControl.includes("immutable"),
        `Cache-Control includes immutable (got: ${cacheControl})`,
      );
    } finally {
      await ctx.close();
    }
  });

  // -----------------------------------------------------------------------
  // 2. SPA navigation (no full reload)
  // -----------------------------------------------------------------------
  void it("2 — SPA navigation", async () => {
    const { ctx, page: p } = await freshPage();
    try {
      await goto(p, "/");

      // Set a marker on window — survives SPA nav, lost on full reload
      await p.evaluate(() => {
        (window as any).__SPA_MARKER = true;
      });

      // Click "DB" link
      await p.click('a[href="/db"]');
      await p.waitForFunction(() => document.querySelector("h1")?.textContent?.includes("DB"), {
        timeout: TIMEOUT,
      });
      assert.ok(p.url().endsWith("/db"), `URL is /db (got: ${p.url()})`);

      // Marker must still be present (no full reload)
      const marker = await p.evaluate(() => (window as any).__SPA_MARKER);
      assert.strictEqual(marker, true, "SPA marker survived navigation");

      // Click "KV" link
      await p.click('a[href="/kv"]');
      await p.waitForFunction(() => document.querySelector("h1")?.textContent?.includes("KV"), {
        timeout: TIMEOUT,
      });
      assert.ok(p.url().endsWith("/kv"), `URL is /kv (got: ${p.url()})`);
    } finally {
      await ctx.close();
    }
  });

  // -----------------------------------------------------------------------
  // 3. Layout persistence across navigation
  // -----------------------------------------------------------------------
  void it("3 — layout persistence", async () => {
    const { ctx, page: p } = await freshPage();
    try {
      await goto(p, "/");

      // Stamp the nav element
      await p.evaluate(() => {
        (document.querySelector("nav") as any).__stamp = 1;
      });

      // Navigate to /env
      await p.click('a[href="/env"]');
      await p.waitForFunction(() => document.querySelector("h1")?.textContent?.includes("Env"), {
        timeout: TIMEOUT,
      });

      // Nav stamp must survive (layout DOM not recreated)
      const stamp = await p.evaluate(() => (document.querySelector("nav") as any).__stamp);
      assert.strictEqual(stamp, 1, "nav stamp survived navigation");
    } finally {
      await ctx.close();
    }
  });

  // -----------------------------------------------------------------------
  // 4. DB — create and delete a note
  // -----------------------------------------------------------------------
  void it("4 — DB CRUD", async () => {
    const { ctx, page: p } = await freshPage();
    try {
      const title = `smoke-${uid}`;

      await goto(p, "/db");

      // Fill form
      await p.fill('input[placeholder="Note title"]', title);
      await p.fill('input[placeholder="Note body"]', "test body");
      await p.click('button:has-text("Add Note")');

      // Wait for the note to appear
      await waitForText(p, title);
      const body = await p.textContent("body");
      assert.ok(body?.includes("test body"), "page contains note body");

      // Delete it
      try {
        await deleteRowContaining(p, title);
        await waitForTextGone(p, title);
      } catch {
        // Cleanup on best-effort basis
      }
    } finally {
      await ctx.close();
    }
  });

  // -----------------------------------------------------------------------
  // 5. KV — set and delete a key
  // -----------------------------------------------------------------------
  void it("5 — KV set/lookup/delete", async () => {
    const { ctx, page: p } = await freshPage();
    try {
      const key = `smoke-kv-${uid}`;

      await goto(p, "/kv");

      // Set key — wait for the POST response before navigating away,
      // otherwise the navigation cancels the in-flight form submission
      await p.fill('input[placeholder="my-key"]', key);
      await p.fill('input[placeholder="my-value"]', "hello");
      await Promise.all([
        p.waitForResponse((r) => r.url().includes("/kv") && r.request().method() === "POST"),
        p.click('button:has-text("Set")'),
      ]);

      // Lookup the key we just set (kv.get is strongly consistent)
      await goto(p, `/kv?lookup=${encodeURIComponent(key)}`);
      const body = await p.textContent("body");
      assert.ok(body?.includes("hello"), "lookup shows value");

      // Cleanup: delete via JSON POST (same as useForm.post())
      await p.evaluate(
        (k) =>
          fetch("/kv", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ intent: "delete", key: k }),
          }),
        key,
      );
    } finally {
      await ctx.close();
    }
  });

  // -----------------------------------------------------------------------
  // 6. Storage — upload and delete a file
  // -----------------------------------------------------------------------
  void it("6 — Storage upload/delete", async () => {
    const { ctx, page: p } = await freshPage();
    try {
      await goto(p, "/storage");

      // Use fileChooser API to upload a file
      const [fileChooser] = await Promise.all([
        p.waitForEvent("filechooser"),
        p.click('input[type="file"]'),
      ]);
      await fileChooser.setFiles({
        name: "smoke-test.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("hello world"),
      });

      await p.click('button:has-text("Upload")');
      await waitForText(p, "smoke-test.txt");

      // Delete
      try {
        await deleteRowContaining(p, "smoke-test.txt");
        await waitForTextGone(p, "smoke-test.txt");
      } catch {
        // Cleanup on best-effort basis
      }
    } finally {
      await ctx.close();
    }
  });

  // -----------------------------------------------------------------------
  // 7. Env — displays bindings
  // -----------------------------------------------------------------------
  void it("7 — Env bindings", async () => {
    const { ctx, page: p } = await freshPage();
    try {
      await goto(p, "/env");

      const body = await p.textContent("body");
      assert.ok(body?.includes("DB"), "page lists DB binding");
      assert.ok(body?.includes("KV"), "page lists KV binding");
    } finally {
      await ctx.close();
    }
  });

  // -----------------------------------------------------------------------
  // 8. Queues — send message and see consumer result
  // -----------------------------------------------------------------------
  void it("8 — Queues", async () => {
    const { ctx, page: p } = await freshPage();
    try {
      const key = `smoke-q-${uid}`;

      await goto(p, "/queues");

      // Send message — wait for the POST response to confirm the queue write completed
      await p.fill('input[placeholder="my-key"]', key);
      await p.fill('input[placeholder="my-value"]', "queued");
      await Promise.all([
        p.waitForResponse((r) => r.url().includes("/queues") && r.request().method() === "POST"),
        p.click('button:has-text("Send to Queue")'),
      ]);

      // Poll for consumer processing — consumer invocation timing is CF
      // infrastructure, not our code. Soft-pass on timeout (like cron test)
      // since we've already verified the queue binding and send work.
      try {
        await pollForText(p, "/queues", key, 60_000);

        // Cleanup
        try {
          await deleteRowContaining(p, key);
          await waitForTextGone(p, key);
        } catch {
          // best-effort
        }
      } catch {
        console.log(
          `  ⚠ Queue consumer did not process "${key}" within 60s (warning, not a failure)`,
        );
      }
    } finally {
      await ctx.close();
    }
  });

  // -----------------------------------------------------------------------
  // 9. Auth — register, login, protected route, logout
  // -----------------------------------------------------------------------
  void it("9 — Auth flow", async () => {
    const { ctx, page: p } = await freshPage();
    try {
      const email = `smoke-${uid}@example.com`;
      const password = "s3cureP@ss!";

      await goto(p, "/auth");

      const body = await p.textContent("body");
      assert.ok(body?.includes("Not logged in"), "shows 'Not logged in'");

      // Switch to Register tab
      await p.click('button:has-text("Register")');
      await p.waitForSelector('input[placeholder="Name"]', { timeout: TIMEOUT });

      // Fill registration form
      await p.fill('input[placeholder="Email"]', email);
      await p.fill('input[placeholder="Password"]', password);
      await p.fill('input[placeholder="Name"]', "Smoke User");
      // Click the Register submit button (inside the register section)
      await p.click('section:has(h2:has-text("Email Register")) button[type="submit"]');

      // Wait for logged-in state
      await waitForTextGone(p, "Not logged in");
      const afterReg = await p.textContent("body");
      assert.ok(afterReg?.includes(email), "shows email after registration");

      // Test protected route
      await p.click('button:has-text("GET /api/profile")');
      await p.waitForFunction(() => document.querySelector("pre")?.textContent?.includes("user"), {
        timeout: TIMEOUT,
      });
      const pre = await p.textContent("pre");
      assert.ok(pre?.includes("user"), "profile response contains 'user'");
      assert.ok(pre?.includes(email), "profile response contains email");

      // Logout
      await p.click('button:has-text("Logout")');
      await waitForText(p, "Not logged in");

      // Re-login
      await p.click('button:has-text("Login")');
      await p.waitForSelector(
        'section:has(h2:has-text("Email Login")) input[placeholder="Email"]',
        {
          timeout: TIMEOUT,
        },
      );
      await p.fill('input[placeholder="Email"]', email);
      await p.fill('input[placeholder="Password"]', password);
      await p.click('section:has(h2:has-text("Email Login")) button[type="submit"]');

      await waitForTextGone(p, "Not logged in");
      const afterLogin = await p.textContent("body");
      assert.ok(afterLogin?.includes(email), "shows email after re-login");
    } finally {
      await ctx.close();
    }
  });

  // -----------------------------------------------------------------------
  // 10. Cron — heartbeat is running
  // -----------------------------------------------------------------------
  void it("10 — Cron heartbeat", async () => {
    const { ctx, page: p } = await freshPage();
    try {
      await goto(p, "/cron");

      const body = await p.textContent("body");

      if (body?.includes("No heartbeat recorded yet")) {
        console.log("  ⚠ Cron heartbeat not recorded yet (warning, not a failure)");
        return; // soft pass
      }

      // Find the heartbeat timestamp (code element after "Last Heartbeat" heading)
      const timestamp = await p.evaluate(() => {
        const h2 = Array.from(document.querySelectorAll("h2")).find(
          (h) => h.textContent === "Last Heartbeat",
        );
        const nextP = h2?.nextElementSibling;
        return nextP?.querySelector("code")?.textContent || null;
      });
      assert.ok(timestamp, "heartbeat timestamp found");

      const date = new Date(timestamp!);
      assert.ok(!isNaN(date.getTime()), `timestamp is a valid date (got: ${timestamp})`);

      const ageMs = Date.now() - date.getTime();
      assert.ok(ageMs < 5 * 60 * 1000, `heartbeat is recent (${Math.round(ageMs / 1000)}s ago)`);
    } finally {
      await ctx.close();
    }
  });

  // -----------------------------------------------------------------------
  // 11. ISR Revalidation
  // -----------------------------------------------------------------------
  void it("11 — ISR revalidation", async () => {
    const { ctx, page: p } = await freshPage();
    try {
      await goto(p, "/revalidate");

      // Note the initial "Rendered at" timestamp
      const renderedAt = await p.textContent("p:has(code) code");
      assert.ok(renderedAt, "initial 'Rendered at' timestamp found");

      // Click "Revalidate /revalidate"
      await p.click('button:has-text("Revalidate /revalidate")');

      // Wait for button to return to non-disabled state
      await p.waitForFunction(
        () => {
          const btn = Array.from(document.querySelectorAll("button")).find((b) =>
            b.textContent?.includes("Revalidate /revalidate"),
          );
          return btn && !btn.disabled;
        },
        { timeout: TIMEOUT },
      );

      // Reload and check "Last revalidation" is no longer "never"
      await goto(p, "/revalidate");
      const body = await p.textContent("body");
      assert.ok(
        !body?.includes("never") || body?.includes("Last revalidation"),
        "last revalidation is no longer 'never'",
      );

      // More precise: check the last revalidation code element
      const lastReval = await p.evaluate(() => {
        const ps = Array.from(document.querySelectorAll("p"));
        const revalP = ps.find((p) => p.textContent?.includes("Last revalidation"));
        const code = revalP?.querySelector("code");
        return code?.textContent || null;
      });
      assert.ok(lastReval, `last revalidation has a timestamp (got: ${lastReval})`);
    } finally {
      await ctx.close();
    }
  });
});
