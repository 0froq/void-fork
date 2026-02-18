import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../../src/index";
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  createTestDeployment,
  type TestEnv,
} from "./helpers";

let env: TestEnv;
let manifestCounter = 0;

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
  test("renders dashboard with stats and projects", async () => {
    const admin = await createTestUser(env.DB, "admin1", "admin");
    await createTestUser(env.DB, "user1");
    await createTestProject(env.DB, admin.id, "dash-proj");

    const res = await req("/", admin.jwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Dashboard");
    expect(html).toContain("Users");
    expect(html).toContain("Projects");
    expect(html).toContain("dash-proj");
  });

  test("stat cards link to views", async () => {
    const admin = await createTestUser(env.DB, "admin1b", "admin");
    const res = await req("/", admin.jwt);
    const html = await res.text();
    expect(html).toContain('href="/users"');
    expect(html).toContain('href="/projects"');
    expect(html).toContain('href="/deployments"');
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

  test("paginates users", async () => {
    const admin = await createTestUser(env.DB, "admin2b", "admin");
    // Create 20 more users to span 2 pages (PAGE_SIZE=20, +1 admin = 21)
    for (let i = 0; i < 20; i++) {
      await createTestUser(env.DB, `paguser-${String(i).padStart(2, "0")}`);
    }

    const res1 = await req("/users", admin.jwt);
    expect(res1.status).toBe(200);
    const html1 = await res1.text();
    expect(html1).toContain("1 / 2");
    expect(html1).toContain("?page=2");

    const res2 = await req("/users?page=2", admin.jwt);
    expect(res2.status).toBe(200);
    const html2 = await res2.text();
    expect(html2).toContain("2 / 2");
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

  test("renders plan limits card", async () => {
    const admin = await createTestUser(env.DB, "admin4b", "admin");
    const user = await createTestUser(env.DB, "limitsuser");

    const res = await req(`/users/${user.id}`, admin.jwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(">Plan<");
    expect(html).toContain("Requests / month");
    expect(html).toContain("3,000,000");
    expect(html).toContain("CPU ms / request");
    expect(html).toContain("Deploys / day");
    expect(html).toContain("D1 storage");
    expect(html).toContain("1 GB");
  });

  test("shows deploy count today", async () => {
    const admin = await createTestUser(env.DB, "admin4c", "admin");
    const user = await createTestUser(env.DB, "deploycountuser");
    const project = await createTestProject(env.DB, user.id, "dc-proj");
    await createTestDeployment(env.DB, project.id, "live");
    await createTestDeployment(env.DB, project.id, "live");

    const res = await req(`/users/${user.id}`, admin.jwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Should show "2 / 100" (2 deploys today, free tier limit 100)
    expect(html).toContain("2 / 100");
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

  test("paginates projects", async () => {
    const admin = await createTestUser(env.DB, "admin7b", "admin");
    // Create 21 projects to span 2 pages (PAGE_SIZE=20)
    for (let i = 0; i < 21; i++) {
      await createTestProject(env.DB, admin.id, `pagproj-${String(i).padStart(2, "0")}`);
    }

    // Page 1: should have 20 projects and a Next link
    const res1 = await req("/projects?page=1", admin.jwt);
    expect(res1.status).toBe(200);
    const html1 = await res1.text();
    expect(html1).toContain("1 / 2");
    expect(html1).toContain("?page=2");

    // Page 2: should have 1 project and no Next link
    const res2 = await req("/projects?page=2", admin.jwt);
    expect(res2.status).toBe(200);
    const html2 = await res2.text();
    expect(html2).toContain("2 / 2");
    expect(html2).toContain("?page=1");
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

  test("shows deployment error in project detail table", async () => {
    const admin = await createTestUser(env.DB, "admin8b", "admin");
    const project = await createTestProject(env.DB, admin.id, "proj-err");
    await createTestDeployment(env.DB, project.id, "failed", "cli", "worker upload failed: 500");

    const res = await req(`/projects/${project.id}`, admin.jwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("worker upload failed: 500");
  });

  test("links deployment IDs to detail page", async () => {
    const admin = await createTestUser(env.DB, "admin8c", "admin");
    const project = await createTestProject(env.DB, admin.id, "proj-link");
    const deployment = await createTestDeployment(env.DB, project.id, "live");

    const res = await req(`/projects/${project.id}`, admin.jwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`/deployments/${deployment.id}`);
  });
});

describe("GET /deployments", () => {
  test("renders deployments list", async () => {
    const admin = await createTestUser(env.DB, "admin10", "admin");
    const user = await createTestUser(env.DB, "deplowner");
    const project = await createTestProject(env.DB, user.id, "depl-proj");
    await createTestDeployment(env.DB, project.id, "live", "cli");

    const res = await req("/deployments", admin.jwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Deployments");
    expect(html).toContain(`/projects/${project.id}`);
    expect(html).toContain("live");
    expect(html).toContain("cli");
  });

  test("shows error preview for failed deployments", async () => {
    const admin = await createTestUser(env.DB, "admin10b", "admin");
    const project = await createTestProject(env.DB, admin.id, "errl-proj");
    await createTestDeployment(env.DB, project.id, "failed", "cli", "migration failed: syntax");

    const res = await req("/deployments", admin.jwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("migration failed: syntax");
  });

  test("paginates deployments", async () => {
    const admin = await createTestUser(env.DB, "admin11", "admin");
    const project = await createTestProject(env.DB, admin.id, "pagdepl-proj");
    for (let i = 0; i < 21; i++) {
      await createTestDeployment(env.DB, project.id, "live");
    }

    const res1 = await req("/deployments?page=1", admin.jwt);
    expect(res1.status).toBe(200);
    const html1 = await res1.text();
    expect(html1).toContain("1 / 2");
    expect(html1).toContain("?page=2");

    const res2 = await req("/deployments?page=2", admin.jwt);
    expect(res2.status).toBe(200);
    const html2 = await res2.text();
    expect(html2).toContain("2 / 2");
    expect(html2).toContain("?page=1");
  });
});

describe("GET /deployments/:id", () => {
  test("renders deployment detail", async () => {
    const admin = await createTestUser(env.DB, "admin12", "admin");
    const project = await createTestProject(env.DB, admin.id, "depldetail-proj");
    const deployment = await createTestDeployment(env.DB, project.id, "live", "cli");

    const res = await req(`/deployments/${deployment.id}`, admin.jwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(deployment.id);
    expect(html).toContain("depldetail-proj");
    expect(html).toContain("live");
    expect(html).toContain("cli");
  });

  test("shows error banner for failed deployment", async () => {
    const admin = await createTestUser(env.DB, "admin12b", "admin");
    const project = await createTestProject(env.DB, admin.id, "errdetail-proj");
    const deployment = await createTestDeployment(
      env.DB,
      project.id,
      "failed",
      "cli",
      "worker upload failed: internal error",
    );

    const res = await req(`/deployments/${deployment.id}`, admin.jwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Error");
    expect(html).toContain("worker upload failed: internal error");
  });

  test("renders parsed manifest card", async () => {
    const admin = await createTestUser(env.DB, "admin12c", "admin");
    const project = await createTestProject(env.DB, admin.id, "manifest-proj");
    const n = ++manifestCounter;
    const id = `dpl_manifest${n}`;
    const manifest = JSON.stringify({
      bindings: { d1: ["DB"], kv: ["CACHE"] },
      migrations: [{ name: "001_init.sql", destructive: false }],
      schedules: [{ name: "sync", cron: "0 * * * *" }],
    });
    await env.DB.prepare(
      "INSERT INTO deployments (id, project_id, status, manifest) VALUES (?, ?, ?, ?)",
    )
      .bind(id, project.id, "live", manifest)
      .run();

    const res = await req(`/deployments/${id}`, admin.jwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Manifest");
    expect(html).toContain("D1");
    expect(html).toContain("DB");
    expect(html).toContain("KV");
    expect(html).toContain("CACHE");
    expect(html).toContain("001_init.sql");
    expect(html).toContain("sync");
    expect(html).toContain("0 * * * *");
    expect(html).toContain("Raw Manifest");
  });

  test("returns 404 for unknown deployment", async () => {
    const admin = await createTestUser(env.DB, "admin13", "admin");
    const res = await req("/deployments/dpl_nonexistent", admin.jwt);
    expect(res.status).toBe(404);
  });
});

describe("GET /login", () => {
  test("renders login page without auth", async () => {
    const res = await app.fetch(new Request("http://localhost/login"), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Vite Cloud Admin");
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
