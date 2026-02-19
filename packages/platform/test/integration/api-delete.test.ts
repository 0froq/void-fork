import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import app from "../../src/index";
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  mockCfApi,
  cfError,
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

afterEach(() => {
  vi.restoreAllMocks();
});

async function addResource(
  projectId: string,
  type: "d1" | "kv" | "r2",
  cfId: string,
  bindingName: string,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO resources (id, project_id, type, cf_id, binding_name) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(`res_${type}_${cfId}`, projectId, type, cfId, bindingName)
    .run();
}

describe("DELETE /projects/:id", () => {
  it("returns 401 without auth", async () => {
    const res = await app.fetch(
      new Request("http://localhost/projects/proj_fake", {
        method: "DELETE",
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 for nonexistent project", async () => {
    const user = await createTestUser(env.DB);
    mockCfApi();

    const res = await app.fetch(
      new Request("http://localhost/projects/proj_nonexistent", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "project not found" });
  });

  it("returns 403 when user does not own project", async () => {
    const alice = await createTestUser(env.DB, "alice");
    const bob = await createTestUser(env.DB, "bob");
    const project = await createTestProject(env.DB, alice.id, "alice-app");
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${bob.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("deletes project with no resources", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id, "empty-app");
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string; slug: string };
    expect(body).toEqual({ ok: true, id: project.id, slug: "empty-app" });

    // Verify project is gone from DB
    const dbProject = await env.DB.prepare("SELECT * FROM projects WHERE id = ?")
      .bind(project.id)
      .first();
    expect(dbProject).toBeNull();
  });

  it("deletes project with resources, assets, and routing", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id, "full-app");
    mockCfApi();

    // Add resources
    await addResource(project.id, "d1", "d1-uuid-123", "DB");
    await addResource(project.id, "kv", "kv-id-456", "KV");
    await addResource(project.id, "r2", "r2-bucket-789", "STORAGE");

    // Add a deployment
    await env.DB.prepare("INSERT INTO deployments (id, project_id, status) VALUES (?, ?, ?)")
      .bind("dpl_test1", project.id, "live")
      .run();

    // Add R2 assets
    await env.ASSETS.put(`${project.id}/current/index.html`, "<h1>Hello</h1>");
    await env.ASSETS.put(`${project.id}/current/assets/app.js`, "console.log('hi')");

    // Add KV routing entry
    await env.ROUTING.put(
      "full-app",
      JSON.stringify({ workerName: "user-full-app", projectId: project.id }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string; slug: string };
    expect(body).toEqual({ ok: true, id: project.id, slug: "full-app" });

    // Verify DB records are gone
    const dbProject = await env.DB.prepare("SELECT * FROM projects WHERE id = ?")
      .bind(project.id)
      .first();
    expect(dbProject).toBeNull();

    const dbResources = await env.DB.prepare("SELECT * FROM resources WHERE project_id = ?")
      .bind(project.id)
      .all();
    expect(dbResources.results).toHaveLength(0);

    const dbDeployments = await env.DB.prepare("SELECT * FROM deployments WHERE project_id = ?")
      .bind(project.id)
      .all();
    expect(dbDeployments.results).toHaveLength(0);

    // Verify R2 assets cleaned up
    const listed = await env.ASSETS.list({ prefix: `${project.id}/` });
    expect(listed.objects).toHaveLength(0);

    // Verify KV routing removed
    const routing = await env.ROUTING.get("full-app");
    expect(routing).toBeNull();
  });

  it("returns warnings on CF resource deletion failure", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id, "warn-app");
    mockCfApi({
      deleteD1: () => cfError("database not found", 404),
    });

    await addResource(project.id, "d1", "d1-gone", "DB");

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; warnings?: string[] };
    expect(body.ok).toBe(true);
    expect(body.warnings).toBeDefined();
    expect(body.warnings!.length).toBeGreaterThan(0);
    expect(body.warnings![0]).toContain("d1");

    // Project should still be deleted from DB despite warnings
    const dbProject = await env.DB.prepare("SELECT * FROM projects WHERE id = ?")
      .bind(project.id)
      .first();
    expect(dbProject).toBeNull();
  });

  it("does not warn when worker 404s (static project)", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id, "static-app");
    // Set mode to spa (static project — no worker deployed)
    await env.DB.prepare("UPDATE projects SET mode = ? WHERE id = ?").bind("spa", project.id).run();
    mockCfApi({
      deleteWorker: () => new Response("not found", { status: 404 }),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; warnings?: string[] };
    expect(body).toEqual({ ok: true, id: project.id, slug: "static-app" });
    expect(body.warnings).toBeUndefined();
  });

  it("calls worker dispatch deletion", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id, "worker-del");
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);

    // Find the worker delete call
    const deleteWorkerCall = fetchMock.mock.calls.find((call: unknown[]) => {
      const url = typeof call[0] === "string" ? call[0] : String(call[0]);
      return (
        url.includes("/workers/dispatch/") &&
        url.includes("user-worker-del") &&
        (call[1] as RequestInit)?.method === "DELETE"
      );
    });
    expect(deleteWorkerCall).toBeDefined();
  });
});
