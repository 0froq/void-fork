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

function req(path: string, jwt?: string, init?: RequestInit): Response | Promise<Response> {
  const headers: Record<string, string> = {};
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  if (init?.body && !init.headers) headers["Content-Type"] = "application/json";
  return app.fetch(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string>) },
    }),
    env,
  );
}

describe("admin middleware", () => {
  test("returns 401 without auth", async () => {
    const res = await req("/admin/stats");
    expect(res.status).toBe(401);
  });

  test("returns 403 for non-admin user", async () => {
    const user = await createTestUser(env.DB, "regularuser");
    const res = await req("/admin/stats", user.jwt);
    expect(res.status).toBe(403);
  });

  test("allows admin user", async () => {
    const admin = await createTestUser(env.DB, "adminuser", "github", undefined, "free", "admin");
    const res = await req("/admin/stats", admin.jwt);
    expect(res.status).toBe(200);
  });
});

describe("GET /admin/stats", () => {
  test("returns system stats", async () => {
    const admin = await createTestUser(env.DB, "admin1", "github", undefined, "free", "admin");
    await createTestUser(env.DB, "user1");
    await createTestProject(env.DB, admin.id);

    const res = await req("/admin/stats", admin.jwt);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { users: number; projects: number; deployments: number };
    expect(data.users).toBe(2);
    expect(data.projects).toBe(1);
    expect(data.deployments).toBe(0);
  });
});

describe("GET /admin/users", () => {
  test("lists all users", async () => {
    const admin = await createTestUser(env.DB, "admin2", "github", undefined, "free", "admin");
    await createTestUser(env.DB, "user2");
    await createTestUser(env.DB, "user3");

    const res = await req("/admin/users", admin.jwt);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { users: unknown[] };
    expect(data.users.length).toBe(3);
  });

  test("searches users by login", async () => {
    const admin = await createTestUser(env.DB, "admin3", "github", undefined, "free", "admin");
    await createTestUser(env.DB, "findme");
    await createTestUser(env.DB, "other");

    const res = await req("/admin/users?search=findme", admin.jwt);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { users: { login: string }[] };
    expect(data.users.length).toBe(1);
    expect(data.users[0].login).toBe("findme");
  });
});

describe("GET /admin/users/:id", () => {
  test("returns user with projects", async () => {
    const admin = await createTestUser(env.DB, "admin4", "github", undefined, "free", "admin");
    const user = await createTestUser(env.DB, "target");
    await createTestProject(env.DB, user.id, "slug1");
    await createTestProject(env.DB, user.id, "slug2");

    const res = await req(`/admin/users/${user.id}`, admin.jwt);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { user: { id: string }; projects: unknown[] };
    expect(data.user.id).toBe(user.id);
    expect(data.projects.length).toBe(2);
  });

  test("returns 404 for unknown user", async () => {
    const admin = await createTestUser(env.DB, "admin5", "github", undefined, "free", "admin");
    const res = await req("/admin/users/user_nonexistent", admin.jwt);
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/users/:id/plan", () => {
  test("updates user plan", async () => {
    const admin = await createTestUser(env.DB, "admin6", "github", undefined, "free", "admin");
    const user = await createTestUser(env.DB, "planuser");

    const res = await req(`/admin/users/${user.id}/plan`, admin.jwt, {
      method: "POST",
      body: JSON.stringify({ plan: "pro" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; plan: string };
    expect(data.ok).toBe(true);
    expect(data.plan).toBe("pro");
  });

  test("rejects invalid plan", async () => {
    const admin = await createTestUser(env.DB, "admin7", "github", undefined, "free", "admin");
    const user = await createTestUser(env.DB, "planuser2");

    const res = await req(`/admin/users/${user.id}/plan`, admin.jwt, {
      method: "POST",
      body: JSON.stringify({ plan: "invalid" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /admin/users/:id/suspend + unsuspend", () => {
  test("suspends and unsuspends a user", async () => {
    const admin = await createTestUser(env.DB, "admin8", "github", undefined, "free", "admin");
    const user = await createTestUser(env.DB, "suspendme");
    const project = await createTestProject(env.DB, user.id, "susp-slug");

    // Set up routing KV
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: "w1", projectId: project.id }),
    );

    // Suspend
    const suspRes = await req(`/admin/users/${user.id}/suspend`, admin.jwt, {
      method: "POST",
      body: JSON.stringify({ reason: "abuse" }),
    });
    expect(suspRes.status).toBe(200);

    // Verify KV updated
    const routingAfterSuspend = JSON.parse((await env.ROUTING.get(project.slug))!);
    expect(routingAfterSuspend.suspended).toBe("abuse");

    // Unsuspend
    const unsuspRes = await req(`/admin/users/${user.id}/unsuspend`, admin.jwt, {
      method: "POST",
      body: "{}",
    });
    expect(unsuspRes.status).toBe(200);

    // Verify KV cleared
    const routingAfterUnsuspend = JSON.parse((await env.ROUTING.get(project.slug))!);
    expect(routingAfterUnsuspend.suspended).toBeUndefined();
  });
});

describe("GET /admin/projects", () => {
  test("lists all projects", async () => {
    const admin = await createTestUser(env.DB, "admin9", "github", undefined, "free", "admin");
    const user = await createTestUser(env.DB, "projowner");
    await createTestProject(env.DB, user.id, "p1");
    await createTestProject(env.DB, user.id, "p2");

    const res = await req("/admin/projects", admin.jwt);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { projects: unknown[] };
    expect(data.projects.length).toBe(2);
  });
});

describe("GET /admin/projects/:id", () => {
  test("returns project detail", async () => {
    const admin = await createTestUser(env.DB, "admin10", "github", undefined, "free", "admin");
    const user = await createTestUser(env.DB, "projowner2");
    const project = await createTestProject(env.DB, user.id, "detail-slug");

    const res = await req(`/admin/projects/${project.id}`, admin.jwt);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      project: { id: string };
      deployments: unknown[];
      resources: unknown[];
    };
    expect(data.project.id).toBe(project.id);
    expect(data.deployments).toEqual([]);
    expect(data.resources).toEqual([]);
  });

  test("returns 404 for unknown project", async () => {
    const admin = await createTestUser(env.DB, "admin11", "github", undefined, "free", "admin");
    const res = await req("/admin/projects/proj_nonexistent", admin.jwt);
    expect(res.status).toBe(404);
  });
});
