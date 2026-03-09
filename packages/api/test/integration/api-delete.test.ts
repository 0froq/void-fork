import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import app from "../../src/index";
import { eq } from "drizzle-orm";
import { resources, projects, deployments } from "../../src/schema";
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
  await clearTables(env.db);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function addResource(
  projectId: string,
  type: "d1" | "kv" | "r2" | "queue",
  cfId: string,
  bindingName: string,
): Promise<void> {
  await env.db.insert(resources).values({
    id: `res_${type}_${cfId}`,
    project_id: projectId,
    type,
    cf_id: cfId,
    binding_name: bindingName,
  });
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
    const user = await createTestUser(env.db);
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
    const alice = await createTestUser(env.db, "alice");
    const bob = await createTestUser(env.db, "bob");
    const project = await createTestProject(env.db, alice.id, "alice-app");
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
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "empty-app");
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
    const [dbProject] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(dbProject).toBeUndefined();
  });

  it("deletes project with resources, assets, and routing", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "full-app");
    mockCfApi();

    // Add resources
    await addResource(project.id, "d1", "d1-uuid-123", "DB");
    await addResource(project.id, "kv", "kv-id-456", "KV");
    await addResource(project.id, "r2", "r2-bucket-789", "STORAGE");

    // Add a deployment
    await env.db.insert(deployments).values({
      id: "dpl_test1",
      project_id: project.id,
      status: "live",
    });

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
    const [dbProject] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(dbProject).toBeUndefined();

    const dbResources = await env.db
      .select()
      .from(resources)
      .where(eq(resources.project_id, project.id));
    expect(dbResources).toHaveLength(0);

    const dbDeployments = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dbDeployments).toHaveLength(0);

    // Verify KV routing removed
    const routing = await env.ROUTING.get("full-app");
    expect(routing).toBeNull();
  });

  it("returns warnings on CF resource deletion failure", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "warn-app");
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
    const [dbProject] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(dbProject).toBeUndefined();
  });

  it("does not warn when worker 404s (static project)", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "static-app");
    // Set type to spa (static project — no worker deployed)
    await env.db.update(projects).set({ type: "spa" }).where(eq(projects.id, project.id));
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

  it("deletes queue resources and routing KV entries", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "queue-app");
    const fetchMock = mockCfApi();
    const queueRoutingKey = `queue:${project.id.replaceAll("_", "-")}-demo-queue`;

    // Add a queue resource
    await addResource(project.id, "queue", "25832cb0ce3d4f60b1e538911a4629f4", "demo-queue");
    await env.db.insert(deployments).values([
      {
        id: "dpl_active",
        project_id: project.id,
        status: "live",
      },
      {
        id: "dpl_failed",
        project_id: project.id,
        status: "failed",
      },
    ]);
    await env.db
      .update(projects)
      .set({ active_deployment_id: "dpl_active" })
      .where(eq(projects.id, project.id));

    // Add queue routing KV entry (as deploy would)
    await env.ROUTING.put(
      queueRoutingKey,
      JSON.stringify({
        workerName: "user-queue-app-dpl_active",
        projectId: project.id,
        queueName: "demo-queue",
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);

    // Verify deleteQueue CF API was called
    const deleteQueueCall = fetchMock.mock.calls.find((call: unknown[]) => {
      const url = typeof call[0] === "string" ? call[0] : String(call[0]);
      return (
        url.includes("/queues/25832cb0ce3d4f60b1e538911a4629f4") &&
        (call[1] as RequestInit)?.method === "DELETE"
      );
    });
    expect(deleteQueueCall).toBeDefined();

    const workerDeleteCalls = fetchMock.mock.calls.filter((call: unknown[]) => {
      const url = typeof call[0] === "string" ? call[0] : String(call[0]);
      return url.includes("/workers/dispatch/") && (call[1] as RequestInit)?.method === "DELETE";
    });
    const deletedWorkers = workerDeleteCalls.map((call: unknown[]) => {
      const url = typeof call[0] === "string" ? call[0] : String(call[0]);
      return url.split("/scripts/")[1];
    });
    expect(deletedWorkers).toEqual(
      expect.arrayContaining([
        "user-queue-app",
        "user-queue-app-dpl_active",
        "user-queue-app-dpl_failed",
      ]),
    );

    const queueDeleteIndex = fetchMock.mock.calls.findIndex((call: unknown[]) => {
      const url = typeof call[0] === "string" ? call[0] : String(call[0]);
      return (
        url.includes("/queues/25832cb0ce3d4f60b1e538911a4629f4") &&
        (call[1] as RequestInit)?.method === "DELETE"
      );
    });
    for (const workerName of ["user-queue-app-dpl_active", "user-queue-app-dpl_failed"]) {
      const workerDeleteIndex = fetchMock.mock.calls.findIndex((call: unknown[]) => {
        const url = typeof call[0] === "string" ? call[0] : String(call[0]);
        return (
          url.includes(`/scripts/${workerName}`) && (call[1] as RequestInit)?.method === "DELETE"
        );
      });
      expect(workerDeleteIndex).toBeGreaterThanOrEqual(0);
      expect(workerDeleteIndex).toBeLessThan(queueDeleteIndex);
    }

    // Verify queue routing KV entry is removed
    const routing = await env.ROUTING.get(queueRoutingKey);
    expect(routing).toBeNull();

    // Verify DB records are gone
    const dbResources = await env.db
      .select()
      .from(resources)
      .where(eq(resources.project_id, project.id));
    expect(dbResources).toHaveLength(0);
  });

  it("deletes the legacy worker name for older projects", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "worker-del");
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);

    // Find the legacy worker delete call
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
