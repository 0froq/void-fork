import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../../src/index";
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  type TestEnv,
} from "./helpers";

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.DB);
});

function req(path: string, cookie?: string, init?: RequestInit): Response | Promise<Response> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string>),
  };
  if (cookie) headers.Cookie = `admin_token=${cookie}`;
  return app.fetch(
    new Request(`http://localhost${path}`, { ...init, headers, redirect: "manual" }),
    env,
  );
}

describe("auth middleware", () => {
  test("redirects to /login without cookie", async () => {
    const res = await req("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  test("redirects to /login with invalid cookie", async () => {
    const res = await req("/", "invalid-token");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  test("returns 403 for non-admin user", async () => {
    const user = await createTestUser(env.DB, "regular");
    const res = await req("/", user.jwt);
    expect(res.status).toBe(403);
  });

  test("allows admin user", async () => {
    const admin = await createTestUser(env.DB, "admin", "admin");
    const res = await req("/", admin.jwt);
    expect(res.status).toBe(200);
  });
});

describe("GET / (dashboard)", () => {
  test("renders dashboard with stats", async () => {
    const admin = await createTestUser(env.DB, "admin1", "admin");
    await createTestUser(env.DB, "user1");
    await createTestProject(env.DB, admin.id);

    const res = await req("/", admin.jwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Dashboard");
    expect(html).toContain("Users");
    expect(html).toContain("Projects");
  });
});

describe("GET /users", () => {
  test("renders users list", async () => {
    const admin = await createTestUser(env.DB, "admin2", "admin");
    await createTestUser(env.DB, "user2");

    const res = await req("/users", admin.jwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("user2");
  });

  test("searches users", async () => {
    const admin = await createTestUser(env.DB, "admin3", "admin");
    await createTestUser(env.DB, "findable");
    await createTestUser(env.DB, "hidden");

    const res = await req("/users?search=findable", admin.jwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("findable");
    expect(html).not.toContain("hidden");
  });
});

describe("GET /users/:id", () => {
  test("renders user detail", async () => {
    const admin = await createTestUser(env.DB, "admin4", "admin");
    const user = await createTestUser(env.DB, "detailuser");

    const res = await req(`/users/${user.id}`, admin.jwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("detailuser");
    expect(html).toContain("Plan");
    expect(html).toContain("Suspension");
  });
});

describe("POST /users/:id/plan", () => {
  test("updates plan and redirects", async () => {
    const admin = await createTestUser(env.DB, "admin5", "admin");
    const user = await createTestUser(env.DB, "planuser");

    const body = new URLSearchParams({ plan: "pro" });
    const res = await req(`/users/${user.id}/plan`, admin.jwt, {
      method: "POST",
      body: body.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" } as Record<string, string>,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/users/${user.id}`);
  });
});

describe("POST /users/:id/suspend + unsuspend", () => {
  test("suspends and unsuspends via forms", async () => {
    const admin = await createTestUser(env.DB, "admin6", "admin");
    const user = await createTestUser(env.DB, "suspuser");
    const project = await createTestProject(env.DB, user.id, "susp-slug");
    await env.ROUTING.put(project.slug, JSON.stringify({ workerName: "w", projectId: project.id }));

    // Suspend
    const suspBody = new URLSearchParams({ reason: "test_reason" });
    const suspRes = await req(`/users/${user.id}/suspend`, admin.jwt, {
      method: "POST",
      body: suspBody.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" } as Record<string, string>,
    });
    expect(suspRes.status).toBe(302);

    const routingAfter = JSON.parse((await env.ROUTING.get(project.slug))!);
    expect(routingAfter.suspended).toBe("test_reason");

    // Unsuspend
    const unsuspRes = await req(`/users/${user.id}/unsuspend`, admin.jwt, {
      method: "POST",
      body: "",
      headers: { "Content-Type": "application/x-www-form-urlencoded" } as Record<string, string>,
    });
    expect(unsuspRes.status).toBe(302);

    const routingAfter2 = JSON.parse((await env.ROUTING.get(project.slug))!);
    expect(routingAfter2.suspended).toBeUndefined();
  });
});

describe("GET /projects", () => {
  test("renders projects list", async () => {
    const admin = await createTestUser(env.DB, "admin7", "admin");
    const user = await createTestUser(env.DB, "projowner");
    await createTestProject(env.DB, user.id, "my-proj");

    const res = await req("/projects", admin.jwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("my-proj");
  });
});

describe("GET /projects/:id", () => {
  test("renders project detail", async () => {
    const admin = await createTestUser(env.DB, "admin8", "admin");
    const user = await createTestUser(env.DB, "projowner2");
    const project = await createTestProject(env.DB, user.id, "detail-proj");

    const res = await req(`/projects/${project.id}`, admin.jwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("detail-proj");
    expect(html).toContain("Resources");
    expect(html).toContain("Recent Deployments");
  });
});

describe("GET /login", () => {
  test("renders login page without auth", async () => {
    const res = await app.fetch(new Request("http://localhost/login"), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Vite Cloud Admin");
    expect(html).toContain("GitHub");
    expect(html).toContain("Google");
  });
});

describe("GET /logout", () => {
  test("clears cookie and redirects", async () => {
    const admin = await createTestUser(env.DB, "admin9", "admin");
    const res = await req("/logout", admin.jwt);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).toContain("admin_token=");
  });
});
