import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import app from "../../src/index";
import { eq, sql } from "drizzle-orm";
import { deployments, resources, domains, projects } from "../../src/schema";
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  createTestDeployment,
  mockCfApi,
  cfSuccess,
  readAllEvents,
  CF_ACCOUNT_ID,
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

function buildDeployForm(opts?: {
  manifest?: object;
  workers?: Record<string, string>;
  assets?: Record<string, string>;
  migrations?: Record<string, string>;
}): FormData {
  const form = new FormData();
  form.append("manifest", JSON.stringify(opts?.manifest ?? { version: 2, bindings: {} }));
  // Default: include at least one worker file
  const workers = opts?.workers ?? {
    "index.js": "export default { fetch() { return new Response('ok'); } }",
  };
  for (const [name, content] of Object.entries(workers)) {
    form.append(`worker:${name}`, new Blob([content]));
  }
  if (opts?.assets) {
    for (const [path, content] of Object.entries(opts.assets)) {
      form.append(`asset:${path}`, new Blob([content]));
    }
  }
  if (opts?.migrations) {
    for (const [name, sql] of Object.entries(opts.migrations)) {
      form.append(`migration:${name}`, new Blob([sql]));
    }
  }
  return form;
}

describe("POST /projects/:id/deploy", () => {
  it("returns 401 without auth", async () => {
    const res = await app.fetch(
      new Request("http://localhost/projects/proj_fake/deploy", {
        method: "POST",
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 for nonexistent project", async () => {
    const user = await createTestUser(env.db);
    mockCfApi();

    const res = await app.fetch(
      new Request("http://localhost/projects/proj_nonexistent/deploy", {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
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
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bob.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("succeeds with minimal deploy (no bindings, no assets)", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "minimal-app");
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const done = events.find((e: any) => e.event === "done") as any;
    expect(done.deployment).toMatch(/^dpl_/);
    expect(done.url).toBe("https://minimal-app.void.app");

    // Verify deployment is marked live in DB
    const [dpl] = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.id, done.deployment));
    expect(dpl?.status).toBe("live");
  });

  it("updates KV routing", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "routed-app");
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const routing = await env.ROUTING.get("routed-app", "json");
    expect(routing).toEqual({
      workerName: "user-routed-app",
      projectId: project.id,
      userId: user.id,
      version: expect.stringMatching(/^dpl_/),
      limits: { cpuMs: 10, subRequests: 50 },
    });
  });

  it("stores ssr flag in KV routing when manifest enables ssr", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "ssr-app");
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: { version: 2, bindings: {}, ssr: true },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const routing = await env.ROUTING.get("ssr-app", "json");
    expect(routing).toEqual({
      workerName: "user-ssr-app",
      projectId: project.id,
      userId: user.id,
      ssr: true,
      version: expect.stringMatching(/^dpl_/),
      limits: { cpuMs: 10, subRequests: 50 },
    });
  });

  it("sends worker upload to correct CF API endpoint", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "worker-app");
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Find the worker upload call
    const uploadCall = fetchMock.mock.calls.find((call: unknown[]) => {
      const url = typeof call[0] === "string" ? call[0] : String(call[0]);
      return url.includes("/workers/dispatch/") && (call[1] as RequestInit)?.method === "PUT";
    });
    expect(uploadCall).toBeDefined();
    const uploadUrl =
      typeof uploadCall![0] === "string" ? uploadCall![0] : uploadCall![0].toString();
    expect(uploadUrl).toContain(
      `/accounts/${CF_ACCOUNT_ID}/workers/dispatch/namespaces/void-users/scripts/user-worker-app`,
    );
  });

  it("syncs cron schedules to CronScheduler DO on deploy", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "cron-app");
    mockCfApi();

    // Track DO fetch calls
    const cronDoFetches: { url: string; body: string }[] = [];
    const cronSchedulerMock = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (_id: unknown) => ({
        fetch: async (req: Request) => {
          const body = await req.text();
          cronDoFetches.push({ url: req.url, body });
          return Response.json({ ok: true });
        },
      }),
    } as unknown as DurableObjectNamespace;

    const testEnv = { ...env, CRON_SCHEDULER: cronSchedulerMock };

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: {
            version: 2,
            bindings: {},
            schedules: [{ name: "sync", cron: "0 * * * *" }],
          },
        }),
      }),
      testEnv,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Verify DO received /sync with correct payload
    const syncCall = cronDoFetches.find((f) => f.url.includes("/sync"));
    expect(syncCall).toBeDefined();
    const payload = JSON.parse(syncCall!.body);
    expect(payload.workerName).toBe("user-cron-app");
    expect(payload.schedules).toEqual([{ name: "sync", cron: "0 * * * *" }]);
  });

  it("clears cron schedules when previous deploy had crons", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "no-cron-app");
    mockCfApi();

    // Simulate previous deploy having crons by setting hasCrons in routing entry
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: `user-${project.slug}`, hasCrons: true }),
    );

    const cronDoFetches: { url: string }[] = [];
    const cronSchedulerMock = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (_id: unknown) => ({
        fetch: async (req: Request) => {
          cronDoFetches.push({ url: req.url });
          return Response.json({ ok: true });
        },
      }),
    } as unknown as DurableObjectNamespace;

    const testEnv = { ...env, CRON_SCHEDULER: cronSchedulerMock };

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: { version: 2, bindings: {} },
        }),
      }),
      testEnv,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Verify DO received /clear
    const clearCall = cronDoFetches.find((f) => f.url.includes("/clear"));
    expect(clearCall).toBeDefined();
  });

  it("skips CronScheduler DO when no crons present or previously configured", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "plain-app");
    mockCfApi();

    let doCalled = false;
    const cronSchedulerMock = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (_id: unknown) => ({
        fetch: async () => {
          doCalled = true;
          return Response.json({ ok: true });
        },
      }),
    } as unknown as DurableObjectNamespace;

    const testEnv = { ...env, CRON_SCHEDULER: cronSchedulerMock };

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: { version: 2, bindings: {} },
        }),
      }),
      testEnv,
    );
    expect(res.status).toBe(200);
    await res.text();

    // DO should NOT have been called
    expect(doCalled).toBe(false);
  });

  it("provisions D1 when manifest requires it", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "d1-app");
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: { version: 2, bindings: { d1: ["DB"] } },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Verify resource row was created in DB
    const [resource] = await env.db
      .select({ cf_id: resources.cf_id, binding_name: resources.binding_name })
      .from(resources)
      .where(eq(resources.project_id, project.id));
    expect(resource).toBeDefined();
    expect(resource!.cf_id).toBe("d1-test-uuid");
    expect(resource!.binding_name).toBe("DB");
  });

  it("skips provisioning when resource already exists", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "existing-d1");
    const fetchMock = mockCfApi();

    // Pre-insert a resource
    await env.db.insert(resources).values({
      id: "res_existing",
      project_id: project.id,
      type: "d1",
      cf_id: "existing-d1-uuid",
      binding_name: "DB",
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: { version: 2, bindings: { d1: ["DB"] } },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Verify no D1 creation call was made
    const createD1Call = fetchMock.mock.calls.find((call: unknown[]) => {
      const url = typeof call[0] === "string" ? call[0] : String(call[0]);
      return (
        url.includes("/d1/database") &&
        !url.includes("/query") &&
        (call[1] as RequestInit)?.method === "POST"
      );
    });
    expect(createD1Call).toBeUndefined();
  });

  it("runs migrations before worker deploy", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "migrate-app");

    const callOrder: string[] = [];
    mockCfApi({
      createD1: () => {
        callOrder.push("createD1");
        return cfSuccess({ uuid: "d1-migrate-uuid", name: "test-db" });
      },
      queryD1: () => {
        callOrder.push("queryD1");
        return cfSuccess([{ results: [] }]);
      },
      uploadWorker: () => {
        callOrder.push("uploadWorker");
        return new Response("ok", { status: 200 });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: { version: 2, bindings: { d1: ["DB"] } },
          migrations: {
            "001_create_table.sql": "CREATE TABLE items (id TEXT PRIMARY KEY)",
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const done = events.find((e: any) => e.event === "done") as any;
    expect(done.migrations).toBe(1);

    // Verify migrations ran before worker upload
    const workerIdx = callOrder.indexOf("uploadWorker");
    const lastQueryIdx = callOrder.lastIndexOf("queryD1");
    expect(lastQueryIdx).toBeLessThan(workerIdx);
  });

  it("rejects destructive migration without pragma", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "destructive-app");
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: { version: 2, bindings: { d1: ["DB"] } },
          migrations: {
            "002_drop.sql": "DROP TABLE users",
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const error = events.find((e: any) => e.event === "error") as any;
    expect(error.message).toContain("destructive migration rejected");
    expect(error.step).toBe("migration");

    // Verify deployment is marked failed with error message
    const [dpl] = await env.db
      .select({ status: deployments.status, error_message: deployments.error_message })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpl?.status).toBe("failed");
    expect(dpl?.error_message).toContain("destructive migration rejected: 002_drop.sql");
  });

  it("updates KV routing for active custom domains on deploy", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "domain-deploy");
    mockCfApi();

    // Insert an active domain
    await env.db.insert(domains).values({
      id: "dom_deploy",
      project_id: project.id,
      hostname: "deploy.example.com",
      cf_hostname_id: "ch-deploy",
      status: "active",
    });

    // Insert a pending domain (should NOT get KV routing)
    await env.db.insert(domains).values({
      id: "dom_pending",
      project_id: project.id,
      hostname: "pending.example.com",
      cf_hostname_id: "ch-pending",
      status: "pending",
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const done = events.find((e: any) => e.event === "done") as any;
    expect(done.url).toBe("https://deploy.example.com");
    expect(done.urls).toContain("https://deploy.example.com");
    expect(done.urls).toContain("https://domain-deploy.void.app");

    // Verify domain KV routing was written
    const domainRouting = await env.ROUTING.get("domain:deploy.example.com", "json");
    expect(domainRouting).toEqual({
      workerName: "user-domain-deploy",
      projectId: project.id,
      userId: user.id,
      version: expect.stringMatching(/^dpl_/),
      limits: { cpuMs: 10, subRequests: 50 },
    });

    // Verify pending domain was NOT written
    const pendingRouting = await env.ROUTING.get("domain:pending.example.com");
    expect(pendingRouting).toBeNull();
  });

  it("returns 429 when deploy count exceeds plan limit", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "limit-app");
    mockCfApi();

    // Insert 100 deployments created today (free tier limit)
    for (let i = 0; i < 100; i++) {
      await env.db.insert(deployments).values({
        id: `dpl_limit_${i}`,
        project_id: project.id,
        status: "live",
        created_at: sql`now()`,
      });
    }

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; limit: number };
    expect(body.error).toBe("deploy limit exceeded");
    expect(body.limit).toBe(100);
  });

  it("allows deploy when under plan limit", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "under-limit-app");
    mockCfApi();

    // Insert 99 deployments (under free tier limit of 100)
    for (let i = 0; i < 99; i++) {
      await env.db.insert(deployments).values({
        id: `dpl_under_${i}`,
        project_id: project.id,
        status: "live",
        created_at: sql`now()`,
      });
    }

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(200);
  });

  it("includes limits in KV routing entry matching user plan", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "limits-kv-app");
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const routing = (await env.ROUTING.get("limits-kv-app", "json")) as {
      limits: { cpuMs: number; subRequests: number };
    };
    expect(routing.limits).toEqual({ cpuMs: 10, subRequests: 50 });
  });

  it("omits limits for custom plan (all unlimited)", async () => {
    const user = await createTestUser(env.db, "customuser", "github", undefined, "custom");
    const project = await createTestProject(env.db, user.id, "custom-plan-app");
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const routing = (await env.ROUTING.get("custom-plan-app", "json")) as Record<string, unknown>;
    expect(routing.limits).toBeUndefined();
  });

  it("includes manifest vars as plain_text bindings in worker upload", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "vars-app");
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: {
            version: 2,
            bindings: {},
            vars: { API_URL: "https://api.example.com", NODE_ENV: "production" },
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const uploadCall = fetchMock.mock.calls.find((call: unknown[]) => {
      const url = typeof call[0] === "string" ? call[0] : String(call[0]);
      return url.includes("/workers/dispatch/") && (call[1] as RequestInit)?.method === "PUT";
    });
    expect(uploadCall).toBeDefined();

    const workerFormData = (uploadCall![1] as RequestInit).body as FormData;
    const metadataBlob = workerFormData.get("metadata");
    expect(metadataBlob).toBeInstanceOf(Blob);
    const metadata = JSON.parse(await (metadataBlob as Blob).text()) as {
      bindings?: { type: string; name: string; text?: string }[];
    };

    const plainTextBindings = (metadata.bindings ?? []).filter((b) => b.type === "plain_text");
    expect(plainTextBindings).toEqual(
      expect.arrayContaining([
        { type: "plain_text", name: "API_URL", text: "https://api.example.com" },
        { type: "plain_text", name: "NODE_ENV", text: "production" },
      ]),
    );
  });

  it("marks deployment failed when worker upload fails", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "fail-app");
    mockCfApi({
      uploadWorker: () => new Response("internal error", { status: 500 }),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const error = events.find((e: any) => e.event === "error") as any;
    expect(error.message).toContain("worker upload failed");
    expect(error.step).toBe("worker_upload");

    // Verify deployment is marked failed with error message
    const [dpl] = await env.db
      .select({ status: deployments.status, error_message: deployments.error_message })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpl?.status).toBe("failed");
    expect(dpl?.error_message).toContain("worker upload failed:");
  });

  it("provisions queue and adds consumer on deploy with queues manifest", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "queue-app");
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: {
            version: 2,
            bindings: {},
            queues: [{ name: "emails", bindingName: "QUEUE_EMAILS" }],
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Verify queue resource was created in DB with queue_id (UUID), not queue_name
    const [resource] = await env.db
      .select({ cf_id: resources.cf_id, binding_name: resources.binding_name })
      .from(resources)
      .where(eq(resources.project_id, project.id));
    expect(resource).toBeDefined();
    expect(resource!.cf_id).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(resource!.binding_name).toBe("emails");

    // Verify addQueueConsumer was called with queue_id (UUID), not queue_name
    const consumerCall = fetchMock.mock.calls.find((call: unknown[]) => {
      const url = typeof call[0] === "string" ? call[0] : String(call[0]);
      return url.includes("/queues/") && url.includes("/consumers");
    });
    expect(consumerCall).toBeDefined();
    const consumerUrl =
      typeof consumerCall![0] === "string" ? consumerCall![0] : String(consumerCall![0]);
    expect(consumerUrl).toContain("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });

  it("includes queue producer binding in worker upload metadata", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "queue-binding-app");
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: {
            version: 2,
            bindings: {},
            queues: [{ name: "emails", bindingName: "QUEUE_EMAILS" }],
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const uploadCall = fetchMock.mock.calls.find((call: unknown[]) => {
      const url = typeof call[0] === "string" ? call[0] : String(call[0]);
      return url.includes("/workers/dispatch/") && (call[1] as RequestInit)?.method === "PUT";
    });
    expect(uploadCall).toBeDefined();

    const workerFormData = (uploadCall![1] as RequestInit).body as FormData;
    const metadataBlob = workerFormData.get("metadata");
    expect(metadataBlob).toBeInstanceOf(Blob);
    const metadata = JSON.parse(await (metadataBlob as Blob).text()) as {
      bindings?: { type: string; name: string; queue_name?: string; queue_id?: string }[];
    };

    // queue_name is the deterministic name (for CF producer binding), queue_id is the UUID
    const expectedQueueName = `${project.id}-emails`.toLowerCase().replaceAll("_", "-");
    const queueBindings = (metadata.bindings ?? []).filter((b) => b.type === "queue");
    expect(queueBindings).toEqual([
      {
        type: "queue",
        name: "QUEUE_EMAILS",
        queue_name: expectedQueueName,
        queue_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      },
    ]);
  });

  it("writes queue routing entry to KV", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "queue-kv-app");
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: {
            version: 2,
            bindings: {},
            queues: [{ name: "emails", bindingName: "QUEUE_EMAILS" }],
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Verify queue routing KV entry (key uses deterministic queue name)
    const expectedQueueName = `${project.id}-emails`.toLowerCase().replaceAll("_", "-");
    const queueRouting = await env.ROUTING.get(`queue:${expectedQueueName}`, "json");
    expect(queueRouting).toEqual({
      workerName: "user-queue-kv-app",
      projectId: project.id,
      queueName: "emails",
    });
  });

  it("streams events in pipeline order", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "stream-test");
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          assets: { "index.html": "<h1>hi</h1>" },
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const eventNames = events.map((e: any) => e.event);

    expect(eventNames[0]).toBe("start");
    expect(eventNames[eventNames.length - 1]).toBe("done");
    expect(eventNames).toContain("worker_upload");
    expect(eventNames).toContain("worker_upload_done");
  });
});

describe("Deploy serialization (concurrent deploy guard)", () => {
  it("returns 409 while a deploy is in progress", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "concurrent-app");
    mockCfApi();

    // Insert an active (non-terminal) deployment
    await env.db.insert(deployments).values({
      id: "dpl_active",
      project_id: project.id,
      status: "uploading",
      created_at: sql`now()`,
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; deployment: string };
    expect(body.error).toBe("deploy in progress");
    expect(body.deployment).toBe("dpl_active");
  });

  it("auto-fails stale deployment (>10 min) and allows new deploy", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "stale-app");
    mockCfApi();

    // Insert a stale active deployment (created 15 minutes ago)
    const staleTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    await env.db.insert(deployments).values({
      id: "dpl_stale",
      project_id: project.id,
      status: "uploading",
      created_at: staleTime,
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Verify stale deployment was auto-failed
    const [stale] = await env.db
      .select({ status: deployments.status, error_message: deployments.error_message })
      .from(deployments)
      .where(eq(deployments.id, "dpl_stale"));
    expect(stale?.status).toBe("failed");
    expect(stale?.error_message).toBe("timed out");
  });

  it("allows deploy when previous deployment is terminal (live)", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "terminal-app");
    mockCfApi();

    // Insert a completed deployment
    await env.db.insert(deployments).values({
      id: "dpl_done",
      project_id: project.id,
      status: "live",
      created_at: sql`now()`,
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(200);
  });
});

function buildStaticDeployForm(opts: {
  type: "spa" | "static";
  assets?: Record<string, string>;
}): FormData {
  const form = new FormData();
  const assetConfig =
    opts.type === "spa"
      ? { not_found_handling: "single-page-application" }
      : { not_found_handling: "404-page" };
  form.append("manifest", JSON.stringify({ version: 2, bindings: {}, assetConfig }));
  if (opts.assets) {
    for (const [path, content] of Object.entries(opts.assets)) {
      form.append(`asset:${path}`, new Blob([content]));
    }
  }
  return form;
}

describe("POST /projects/:id/deploy (static)", () => {
  it("succeeds with static SPA deploy (passthrough worker)", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "spa-site");
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildStaticDeployForm({
          type: "spa",
          assets: {
            "index.html": "<html>SPA</html>",
            "assets/app-abc123.js": "console.log('spa')",
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const done = events.find((e: any) => e.event === "done") as any;
    expect(done.deployment).toMatch(/^dpl_/);
    expect(done.url).toBe("https://spa-site.void.app");
    expect(done.assets).toBe(2);
    expect(done.workers).toBe(1);
  });

  it("writes KV routing with workerName for static SPA", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "kv-spa");
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildStaticDeployForm({ type: "spa" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const routing = await env.ROUTING.get("kv-spa", "json");
    expect(routing).toEqual({
      workerName: "user-kv-spa",
      projectId: project.id,
      userId: user.id,
      version: expect.stringMatching(/^dpl_/),
    });
  });

  it("updates project type column on static deploy", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "mode-update");
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildStaticDeployForm({ type: "static" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const [row] = await env.db
      .select({ type: projects.type })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(row?.type).toBe("static");
  });
});

describe("Deploy with prerendering", () => {
  it("prerenders pages and writes ISR cache entries to KV", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "prerender-app");

    // Mock DISPATCH.get() to return a fetchable worker
    const dispatchGet = vi.fn().mockReturnValue({
      fetch: vi.fn().mockImplementation(
        () =>
          new Response("<html>Prerendered</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    });
    env.DISPATCH = { get: dispatchGet } as unknown as DispatchNamespace;

    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: {
            version: 2,
            bindings: {},
            revalidate: 3600,
            prerender: ["/", "/about"],
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Verify ISR cache entries were written to KV (packed binary format)
    const { value: homeValue, metadata: homeMeta } = await env.ISR_CACHE.getWithMetadata<{
      s: number;
      c: number;
      t: number;
    }>(`${project.id}/isr/__index__`, "arrayBuffer");
    expect(homeValue).not.toBeNull();
    // Unpack: [4-byte header len][headers JSON][body]
    const homeView = new DataView(homeValue!);
    const homeHeaderLen = homeView.getUint32(0, true);
    const homeBody = new TextDecoder().decode(new Uint8Array(homeValue!, 4 + homeHeaderLen));
    expect(homeBody).toBe("<html>Prerendered</html>");
    expect(homeMeta?.s).toBe(200);
    expect(homeMeta?.t).toBe(3600);

    const { value: aboutValue } = await env.ISR_CACHE.getWithMetadata(
      `${project.id}/isr/about`,
      "arrayBuffer",
    );
    expect(aboutValue).not.toBeNull();

    // Verify deployment is live
    const [dpl] = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpl?.status).toBe("live");
  });

  it("skips prerender paths with TTL <= 0", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "prerender-skip");

    const dispatchFetch = vi.fn().mockImplementation(
      () =>
        new Response("<html>Prerendered</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    const dispatchGet = vi.fn().mockReturnValue({ fetch: dispatchFetch });
    env.DISPATCH = { get: dispatchGet } as unknown as DispatchNamespace;

    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: {
            version: 2,
            bindings: {},
            revalidate: { "/about": 3600, "/private": 0, "*": 0 },
            prerender: ["/about", "/private"],
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Only /about should have been fetched (TTL > 0)
    expect(dispatchFetch).toHaveBeenCalledTimes(1);

    // /about should have ISR entry
    const { value: aboutValue } = await env.ISR_CACHE.getWithMetadata(
      `${project.id}/isr/about`,
      "arrayBuffer",
    );
    expect(aboutValue).not.toBeNull();

    // /private should NOT have ISR entry
    const { value: privateValue } = await env.ISR_CACHE.getWithMetadata(
      `${project.id}/isr/private`,
      "arrayBuffer",
    );
    expect(privateValue).toBeNull();
  });

  it("does not block deploy when prerender fails", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "prerender-fail");

    const dispatchGet = vi.fn().mockReturnValue({
      fetch: vi.fn().mockRejectedValue(new Error("Worker crashed")),
    });
    env.DISPATCH = { get: dispatchGet } as unknown as DispatchNamespace;

    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: {
            version: 2,
            bindings: {},
            revalidate: 3600,
            prerender: ["/"],
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Deployment should still be live despite prerender failure
    const [dpl] = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpl?.status).toBe("live");
  });

  it("sets prerendering status during prerender phase", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "prerender-status");

    let statusDuringPrerender: string | undefined;
    const dispatchGet = vi.fn().mockReturnValue({
      fetch: vi.fn().mockImplementation(async () => {
        // Check deployment status during prerender
        const [dpl] = await env.db
          .select({ status: deployments.status })
          .from(deployments)
          .where(eq(deployments.project_id, project.id));
        statusDuringPrerender = dpl?.status;
        return new Response("<html>ok</html>", { status: 200 });
      }),
    });
    env.DISPATCH = { get: dispatchGet } as unknown as DispatchNamespace;

    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: {
            version: 2,
            bindings: {},
            revalidate: 3600,
            prerender: ["/"],
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();
    expect(statusDuringPrerender).toBe("prerendering");
  });
});

describe("asset_hashes storage", () => {
  it("stores asset_hashes in deployment record after successful deploy", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    mockCfApi();

    const form = buildDeployForm({ assets: { "index.html": "<html>hello</html>" } });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );

    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const data = events.find((e: any) => e.event === "done") as any;

    const [row] = await env.db
      .select({ asset_hashes: deployments.asset_hashes })
      .from(deployments)
      .where(eq(deployments.id, data.deployment));

    expect(row?.asset_hashes).toBeTruthy();
    const hashes = JSON.parse(row!.asset_hashes!);
    expect(hashes["/index.html"]).toBeDefined();
    expect(hashes["/index.html"].hash).toHaveLength(32);
    expect(hashes["/index.html"].size).toBeGreaterThan(0);
  });
});

describe("POST /projects/:id/deploy/preflight", () => {
  it("returns 401 without auth", async () => {
    const res = await app.fetch(
      new Request("http://localhost/projects/proj_fake/deploy/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetManifest: {} }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("returns all assets as needed on first deploy", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy/preflight`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          assetManifest: {
            "/index.html": { hash: "a".repeat(32), size: 100 },
            "/app.js": { hash: "b".repeat(32), size: 200 },
          },
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as { needed: string[]; total: number; skipped: number };
    expect(data.needed.sort()).toEqual(["/app.js", "/index.html"]);
    expect(data.total).toBe(2);
    expect(data.skipped).toBe(0);
  });

  it("skips unchanged assets from previous deploy", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    // Create a previous deployment with known asset hashes
    const prevManifest = {
      "/index.html": { hash: "a".repeat(32), size: 100 },
      "/app.js": { hash: "b".repeat(32), size: 200 },
      "/style.css": { hash: "c".repeat(32), size: 300 },
    };
    const prevDeploy = await createTestDeployment(env.db, project.id, "live");
    await env.db
      .update(deployments)
      .set({ asset_hashes: JSON.stringify(prevManifest) })
      .where(eq(deployments.id, prevDeploy.id));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy/preflight`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          assetManifest: {
            "/index.html": { hash: "a".repeat(32), size: 100 }, // unchanged
            "/app.js": { hash: "x".repeat(32), size: 250 }, // changed
            "/new.js": { hash: "d".repeat(32), size: 400 }, // new
            // style.css removed
          },
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as { needed: string[]; total: number; skipped: number };
    expect(data.needed.sort()).toEqual(["/app.js", "/new.js"]);
    expect(data.total).toBe(3);
    expect(data.skipped).toBe(1);
  });

  it("merges previous asset manifest when preflight flag is set on deploy", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    // Set up a previous deploy with known asset hashes
    const prevManifest = {
      "/index.html": { hash: "a".repeat(32), size: 100 },
      "/app.js": { hash: "b".repeat(32), size: 200 },
    };
    const prevDeploy = await createTestDeployment(env.db, project.id, "live");
    await env.db
      .update(deployments)
      .set({ asset_hashes: JSON.stringify(prevManifest) })
      .where(eq(deployments.id, prevDeploy.id));

    // Deploy with preflight=true, only sending the changed asset
    let sessionManifest: Record<string, unknown> | null = null;
    mockCfApi({
      assetUploadSession: (_url, init) => {
        const body = JSON.parse(init?.body as string);
        sessionManifest = body.manifest;
        return cfSuccess({ jwt: "test-asset-jwt", buckets: [] });
      },
    });

    const form = new FormData();
    form.append("manifest", JSON.stringify({ version: 2, bindings: {} }));
    form.append("preflight", "true");
    form.append("asset:app.js", new Blob(["new content"]), "app.js");
    form.append("worker:index.js", new Blob(["export default {}"]), "index.js");

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );

    expect(res.status).toBe(200);
    await res.text();

    // CF session should have received the COMPLETE manifest (merged)
    expect(sessionManifest).toBeDefined();
    expect(Object.keys(sessionManifest!).sort()).toEqual(["/app.js", "/index.html"]);
  });

  it("includes observability metadata in worker upload", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "obs-proj");

    let capturedMetadata: Record<string, unknown> | undefined;
    mockCfApi({
      uploadWorker: async (_url: string, init?: RequestInit) => {
        const body = init?.body as FormData;
        const metadataBlob = body.get("metadata") as Blob;
        capturedMetadata = JSON.parse(await metadataBlob.text());
        return new Response("ok", { status: 200 });
      },
    });

    const form = buildDeployForm();
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();
    expect(capturedMetadata).toBeDefined();
    expect(capturedMetadata!.observability).toEqual({
      enabled: true,
      logs: { invocation_logs: true, head_sampling_rate: 1 },
    });
  });
});
