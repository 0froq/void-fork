import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const DEV_PORT = 5195;
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

describe("playground/vue-pages", () => {
  it("dev: SSR pages, Inertia protocol, form handling, API coexistence", async () => {
    const child = spawn(
      "pnpm",
      [
        "--dir",
        "playground/vue-pages",
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

      // 1. Initial page load returns SSR HTML with data-page attribute
      const rootRes = await fetch(`${BASE}/`);
      expect(rootRes.status).toBe(200);
      const rootHtml = await rootRes.text();
      expect(rootHtml).toContain("data-page=");
      expect(rootHtml).toContain("Welcome");
      expect(rootHtml).toContain("Vue Pages Demo"); // shared data from middleware

      // 2. SSR content contains server-rendered props
      expect(rootHtml).toContain("This is the Vue Pages playground.");

      // 3. Users page SSR — server-rendered user list
      const usersRes = await fetch(`${BASE}/users`);
      expect(usersRes.status).toBe(200);
      const usersHtml = await usersRes.text();
      expect(usersHtml).toContain("data-page=");
      expect(usersHtml).toContain("Alice");
      expect(usersHtml).toContain("Bob");
      expect(usersHtml).toContain("Vue Pages Demo"); // layout with shared data

      // 4. User detail page SSR
      const userRes = await fetch(`${BASE}/users/1`);
      expect(userRes.status).toBe(200);
      const userHtml = await userRes.text();
      expect(userHtml).toContain("Alice");
      expect(userHtml).toContain("alice@example.com");

      // 5. Inertia navigation — GET / with X-Inertia header returns JSON page object
      const inertiaRoot = await fetch(`${BASE}/`, {
        headers: { "X-Inertia": "true" },
      });
      expect(inertiaRoot.status).toBe(200);
      expect(inertiaRoot.headers.get("X-Inertia")).toBe("true");
      const rootPage = (await inertiaRoot.json()) as {
        component: string;
        props: Record<string, unknown>;
        shared: Record<string, unknown>;
        url: string;
      };
      expect(rootPage.component).toBe("index");
      expect(rootPage.props).toHaveProperty("title", "Home");
      expect(rootPage.shared).toHaveProperty("appName", "Vue Pages Demo");
      expect(rootPage.url).toBe("/");

      // 6. Inertia navigation — GET /users returns user list in props
      const inertiaUsers = await fetch(`${BASE}/users`, {
        headers: { "X-Inertia": "true" },
      });
      expect(inertiaUsers.status).toBe(200);
      const usersPage = (await inertiaUsers.json()) as {
        component: string;
        props: { users: Array<{ id: number; name: string }> };
      };
      expect(usersPage.component).toBe("users");
      expect(usersPage.props.users).toHaveLength(2);
      expect(usersPage.props.users[0].name).toBe("Alice");

      // 7. API coexistence — /api/health returns JSON (not a page object)
      const healthRes = await fetch(`${BASE}/api/health`);
      expect(healthRes.status).toBe(200);
      const healthBody = (await healthRes.json()) as { status: string };
      expect(healthBody.status).toBe("ok");

      // 8. Form submission — POST /users with valid data
      const postValid = await fetch(`${BASE}/users`, {
        method: "POST",
        headers: { "X-Inertia": "true", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Charlie", email: "charlie@example.com" }),
      });
      expect(postValid.status).toBe(200);
      const validPage = (await postValid.json()) as {
        component: string;
        props: { users: Array<{ id: number; name: string }> };
        errors: Record<string, string> | null;
      };
      expect(validPage.errors).toBeNull();
      expect(validPage.props.users).toHaveLength(3);
      expect(validPage.props.users[2].name).toBe("Charlie");

      // 9. Form submission — POST /users with invalid data returns validation errors
      const postInvalid = await fetch(`${BASE}/users`, {
        method: "POST",
        headers: { "X-Inertia": "true", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "", email: "" }),
      });
      expect(postInvalid.status).toBe(200);
      const invalidPage = (await postInvalid.json()) as {
        component: string;
        props: { users: Array<{ id: number; name: string }> };
        errors: Record<string, string> | null;
      };
      expect(invalidPage.errors).not.toBeNull();
      expect(invalidPage.errors!.name).toBe("Name is required");
      expect(invalidPage.errors!.email).toBe("Email is required");
      // Props should still be populated (re-ran GET)
      expect(invalidPage.props.users.length).toBeGreaterThanOrEqual(2);

      // 10. User detail via Inertia
      const inertiaUser = await fetch(`${BASE}/users/1`, {
        headers: { "X-Inertia": "true" },
      });
      expect(inertiaUser.status).toBe(200);
      const userPage = (await inertiaUser.json()) as {
        component: string;
        props: { user: { id: number; name: string; email: string } };
      };
      expect(userPage.component).toBe("users/[id]");
      expect(userPage.props.user.name).toBe("Alice");
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
