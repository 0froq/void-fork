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
  mockCfApi,
  cfSuccess,
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
  form.append("manifest", JSON.stringify(opts?.manifest ?? { version: 1, bindings: {} }));
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
    const body = (await res.json()) as {
      deployment: string;
      url: string;
    };
    expect(body.deployment).toMatch(/^dpl_/);
    expect(body.url).toBe("https://minimal-app.vitecloud.app");

    // Verify deployment is marked live in D1
    const dpl = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.id, body.deployment))
      .get();
    expect(dpl?.status).toBe("live");
  });

  it("stores assets in R2 at correct keys", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "asset-app");
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          assets: {
            "index.html": "<h1>Hello</h1>",
            "assets/app-abc123.js": "console.log('hi')",
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assets: number };
    expect(body.assets).toBe(2);

    // Verify R2 contents
    const html = await env.ASSETS.get(`${project.id}/current/index.html`);
    expect(html).not.toBeNull();
    expect(await html!.text()).toBe("<h1>Hello</h1>");

    const js = await env.ASSETS.get(`${project.id}/current/assets/app-abc123.js`);
    expect(js).not.toBeNull();
    expect(await js!.text()).toBe("console.log('hi')");
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

    const routing = await env.ROUTING.get("routed-app", "json");
    expect(routing).toEqual({
      workerName: "user-routed-app",
      projectId: project.id,
      userId: user.id,
      version: expect.stringMatching(/^dpl_/),
      limits: { cpuMs: 10, subRequests: 50 },
    });
  });

  it("includes header rules in KV routing for full deploy", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "headers-full");
    mockCfApi();

    const headers = [
      { pattern: "/*", headers: [["X-Frame-Options", "DENY"]] as [string, string][] },
    ];

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: { version: 1, bindings: {}, headers },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const routing = await env.ROUTING.get("headers-full", "json");
    expect(routing).toEqual({
      workerName: "user-headers-full",
      projectId: project.id,
      userId: user.id,
      version: expect.stringMatching(/^dpl_/),
      headers,
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
          manifest: { version: 1, bindings: {}, ssr: true },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

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

  it("passes cron triggers to worker upload metadata", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "cron-app");
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: {
            version: 1,
            bindings: {},
            schedules: [{ name: "sync", cron: "0 * * * *" }],
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const uploadCall = fetchMock.mock.calls.find((call: unknown[]) => {
      const url = typeof call[0] === "string" ? call[0] : String(call[0]);
      return url.includes("/workers/dispatch/") && (call[1] as RequestInit)?.method === "PUT";
    });
    expect(uploadCall).toBeDefined();

    const workerFormData = (uploadCall![1] as RequestInit).body as FormData;
    const metadataBlob = workerFormData.get("metadata");
    expect(metadataBlob).toBeInstanceOf(Blob);
    const metadata = JSON.parse(await (metadataBlob as Blob).text()) as {
      triggers?: { crons?: string[] };
    };

    expect(metadata.triggers?.crons).toEqual(["0 * * * *"]);
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
          manifest: { version: 1, bindings: { d1: ["DB"] } },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    // Verify resource row was created in D1
    const resource = await env.db
      .select({ cf_id: resources.cf_id, binding_name: resources.binding_name })
      .from(resources)
      .where(eq(resources.project_id, project.id))
      .get();
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
          manifest: { version: 1, bindings: { d1: ["DB"] } },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

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
          manifest: { version: 1, bindings: { d1: ["DB"] } },
          migrations: {
            "001_create_table.sql": "CREATE TABLE items (id TEXT PRIMARY KEY)",
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { migrations: number };
    expect(body.migrations).toBe(1);

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
          manifest: { version: 1, bindings: { d1: ["DB"] } },
          migrations: {
            "002_drop.sql": "DROP TABLE users",
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("destructive migration rejected");

    // Verify deployment is marked failed with error message
    const dpl = await env.db
      .select({ status: deployments.status, error_message: deployments.error_message })
      .from(deployments)
      .where(eq(deployments.project_id, project.id))
      .get();
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
    const body = (await res.json()) as { url: string; urls: string[] };
    expect(body.url).toBe("https://deploy.example.com");
    expect(body.urls).toContain("https://deploy.example.com");
    expect(body.urls).toContain("https://domain-deploy.vitecloud.app");

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
        created_at: sql`datetime('now')`,
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
        created_at: sql`datetime('now')`,
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
            version: 1,
            bindings: {},
            vars: { API_URL: "https://api.example.com", NODE_ENV: "production" },
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

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
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("worker upload failed");

    // Verify deployment is marked failed with error message
    const dpl = await env.db
      .select({ status: deployments.status, error_message: deployments.error_message })
      .from(deployments)
      .where(eq(deployments.project_id, project.id))
      .get();
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
            version: 1,
            bindings: {},
            queues: [{ name: "emails", bindingName: "QUEUE_EMAILS" }],
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    // Verify queue resource was created in D1
    const resource = await env.db
      .select({ cf_id: resources.cf_id, binding_name: resources.binding_name })
      .from(resources)
      .where(eq(resources.project_id, project.id))
      .get();
    expect(resource).toBeDefined();
    expect(resource!.cf_id).toBe("queue-test-id");
    expect(resource!.binding_name).toBe("emails");

    // Verify addQueueConsumer was called
    const consumerCall = fetchMock.mock.calls.find((call: unknown[]) => {
      const url = typeof call[0] === "string" ? call[0] : String(call[0]);
      return url.includes("/queues/") && url.includes("/consumers");
    });
    expect(consumerCall).toBeDefined();
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
            version: 1,
            bindings: {},
            queues: [{ name: "emails", bindingName: "QUEUE_EMAILS" }],
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const uploadCall = fetchMock.mock.calls.find((call: unknown[]) => {
      const url = typeof call[0] === "string" ? call[0] : String(call[0]);
      return url.includes("/workers/dispatch/") && (call[1] as RequestInit)?.method === "PUT";
    });
    expect(uploadCall).toBeDefined();

    const workerFormData = (uploadCall![1] as RequestInit).body as FormData;
    const metadataBlob = workerFormData.get("metadata");
    expect(metadataBlob).toBeInstanceOf(Blob);
    const metadata = JSON.parse(await (metadataBlob as Blob).text()) as {
      bindings?: { type: string; name: string; queue_name?: string }[];
    };

    const queueBindings = (metadata.bindings ?? []).filter((b) => b.type === "queue");
    expect(queueBindings).toEqual([
      { type: "queue", name: "QUEUE_EMAILS", queue_name: "queue-test-id" },
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
            version: 1,
            bindings: {},
            queues: [{ name: "emails", bindingName: "QUEUE_EMAILS" }],
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    // Verify queue routing KV entry
    const queueRouting = await env.ROUTING.get("queue:queue-test-id", "json");
    expect(queueRouting).toEqual({
      workerName: "user-queue-kv-app",
      projectId: project.id,
      queueName: "emails",
    });
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
      created_at: sql`datetime('now')`,
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

    // Verify stale deployment was auto-failed
    const stale = await env.db
      .select({ status: deployments.status, error_message: deployments.error_message })
      .from(deployments)
      .where(eq(deployments.id, "dpl_stale"))
      .get();
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
      created_at: sql`datetime('now')`,
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
  mode: "spa" | "ssg";
  assets?: Record<string, string>;
  assetHashes?: Record<string, string>;
  headers?: { pattern: string; headers: [string, string][] }[];
}): FormData {
  const form = new FormData();
  const manifest: Record<string, unknown> = { version: 1, bindings: {}, static: opts.mode };
  if (opts.assetHashes) {
    manifest.assetHashes = opts.assetHashes;
  }
  if (opts.headers) {
    manifest.headers = opts.headers;
  }
  form.append("manifest", JSON.stringify(manifest));
  if (opts.assets) {
    for (const [path, content] of Object.entries(opts.assets)) {
      form.append(`asset:${path}`, new Blob([content]));
    }
  }
  return form;
}

describe("POST /projects/:id/deploy (static)", () => {
  it("succeeds with static SPA deploy (no worker upload)", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "spa-site");
    // No mockCfApi needed — static deploys don't call CF API

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildStaticDeployForm({
          mode: "spa",
          assets: {
            "index.html": "<html>SPA</html>",
            "assets/app-abc123.js": "console.log('spa')",
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deployment: string;
      url: string;
      assets: number;
      workers: number;
    };
    expect(body.deployment).toMatch(/^dpl_/);
    expect(body.url).toBe("https://spa-site.vitecloud.app");
    expect(body.assets).toBe(2);
    expect(body.workers).toBe(0);
  });

  it("stores static assets in R2", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "static-r2");

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildStaticDeployForm({
          mode: "ssg",
          assets: {
            "index.html": "<html>SSG</html>",
            "about/index.html": "<html>About</html>",
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const html = await env.ASSETS.get(`${project.id}/current/index.html`);
    expect(html).not.toBeNull();
    expect(await html!.text()).toBe("<html>SSG</html>");

    const about = await env.ASSETS.get(`${project.id}/current/about/index.html`);
    expect(about).not.toBeNull();
    expect(await about!.text()).toBe("<html>About</html>");
  });

  it("writes KV routing with mode for static SPA", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "kv-spa");

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildStaticDeployForm({ mode: "spa" }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const routing = await env.ROUTING.get("kv-spa", "json");
    expect(routing).toEqual({
      projectId: project.id,
      userId: user.id,
      mode: "spa",
      version: expect.stringMatching(/^dpl_/),
    });
  });

  it("includes header rules in KV routing when manifest has headers", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "headers-spa");

    const headers = [
      { pattern: "/*", headers: [["X-Frame-Options", "DENY"]] as [string, string][] },
      {
        pattern: "/assets/*",
        headers: [["Cache-Control", "public, max-age=31536000, immutable"]] as [string, string][],
      },
    ];

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildStaticDeployForm({ mode: "spa", headers }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const routing = await env.ROUTING.get("headers-spa", "json");
    expect(routing).toEqual({
      projectId: project.id,
      userId: user.id,
      mode: "spa",
      version: expect.stringMatching(/^dpl_/),
      headers,
    });
  });

  it("writes KV routing with mode for static SSG", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "kv-ssg");

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildStaticDeployForm({ mode: "ssg" }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const routing = await env.ROUTING.get("kv-ssg", "json");
    expect(routing).toEqual({
      projectId: project.id,
      userId: user.id,
      mode: "ssg",
      version: expect.stringMatching(/^dpl_/),
    });
  });

  it("updates project mode column on static deploy", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "mode-update");

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildStaticDeployForm({ mode: "ssg" }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const row = await env.db
      .select({ mode: projects.mode })
      .from(projects)
      .where(eq(projects.id, project.id))
      .get();
    expect(row?.mode).toBe("ssg");
  });
});

describe("POST /projects/:id/assets/check", () => {
  it("returns all paths as needed when no manifest exists", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "check-new");

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/assets/check`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({
          assets: { "index.html": "abc123", "assets/app.js": "def456" },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { needed: string[] };
    expect(body.needed.sort()).toEqual(["assets/app.js", "index.html"]);
  });

  it("returns empty needed list when all hashes match", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "check-match");

    // Seed manifest
    await env.ASSETS.put(
      `${project.id}/asset-manifest.json`,
      JSON.stringify({ "index.html": "abc123", "assets/app.js": "def456" }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/assets/check`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({
          assets: { "index.html": "abc123", "assets/app.js": "def456" },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { needed: string[] };
    expect(body.needed).toEqual([]);
  });

  it("returns only changed and new paths", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "check-partial");

    // Seed manifest with two files
    await env.ASSETS.put(
      `${project.id}/asset-manifest.json`,
      JSON.stringify({ "index.html": "abc123", "assets/old.js": "old111" }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/assets/check`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({
          assets: {
            "index.html": "abc123", // unchanged
            "assets/old.js": "new222", // changed hash
            "assets/new.js": "brand999", // new file
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { needed: string[] };
    expect(body.needed.sort()).toEqual(["assets/new.js", "assets/old.js"]);
  });

  it("returns 401 without auth", async () => {
    const res = await app.fetch(
      new Request("http://localhost/projects/proj_fake/assets/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assets: {} }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when user does not own project", async () => {
    const alice = await createTestUser(env.db, "alice-check");
    const bob = await createTestUser(env.db, "bob-check");
    const project = await createTestProject(env.db, alice.id, "check-forbidden");

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/assets/check`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bob.jwt}`,
        },
        body: JSON.stringify({ assets: {} }),
      }),
      env,
    );
    expect(res.status).toBe(403);
  });
});

describe("Deploy with assetHashes (manifest management)", () => {
  it("writes asset manifest to R2 on deploy", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "manifest-write");

    const hashes = { "index.html": "aaa111", "assets/app.js": "bbb222" };
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildStaticDeployForm({
          mode: "spa",
          assets: { "index.html": "<html>hi</html>", "assets/app.js": "console.log(1)" },
          assetHashes: hashes,
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const manifestObj = await env.ASSETS.get(`${project.id}/asset-manifest.json`);
    expect(manifestObj).not.toBeNull();
    const stored = (await manifestObj!.json()) as Record<string, string>;
    expect(stored).toEqual(hashes);
  });

  it("deletes stale R2 objects on deploy", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "manifest-stale");

    // Seed old manifest and R2 objects
    await env.ASSETS.put(
      `${project.id}/asset-manifest.json`,
      JSON.stringify({ "index.html": "aaa", "old-file.js": "bbb" }),
    );
    await env.ASSETS.put(`${project.id}/current/index.html`, "<html>old</html>");
    await env.ASSETS.put(`${project.id}/current/old-file.js`, "old content");

    // Deploy with only index.html (old-file.js removed)
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildStaticDeployForm({
          mode: "spa",
          assets: { "index.html": "<html>new</html>" },
          assetHashes: { "index.html": "ccc" },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    // Stale file should be deleted
    const stale = await env.ASSETS.get(`${project.id}/current/old-file.js`);
    expect(stale).toBeNull();

    // Current file should be updated
    const current = await env.ASSETS.get(`${project.id}/current/index.html`);
    expect(current).not.toBeNull();
    expect(await current!.text()).toBe("<html>new</html>");

    // Manifest should be updated
    const manifestObj = await env.ASSETS.get(`${project.id}/asset-manifest.json`);
    const stored = (await manifestObj!.json()) as Record<string, string>;
    expect(stored).toEqual({ "index.html": "ccc" });
  });
});

describe("Deploy with prerendering", () => {
  it("prerenders pages and writes ISR cache entries to R2", async () => {
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
            version: 1,
            bindings: {},
            revalidate: 3600,
            prerender: ["/", "/about"],
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    // Verify ISR cache entries were written to R2
    const homeEntry = await env.ASSETS.get(`${project.id}/isr/__index__`);
    expect(homeEntry).not.toBeNull();
    expect(await homeEntry!.text()).toBe("<html>Prerendered</html>");
    const homeMeta = homeEntry!.customMetadata;
    expect(homeMeta?.status).toBe("200");
    expect(homeMeta?.ttl).toBe("3600");

    const aboutEntry = await env.ASSETS.get(`${project.id}/isr/about`);
    expect(aboutEntry).not.toBeNull();
    expect(await aboutEntry!.text()).toBe("<html>Prerendered</html>");

    // Verify deployment is live
    const dpl = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.project_id, project.id))
      .get();
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
            version: 1,
            bindings: {},
            revalidate: { "/about": 3600, "/private": 0, "*": 0 },
            prerender: ["/about", "/private"],
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    // Only /about should have been fetched (TTL > 0)
    expect(dispatchFetch).toHaveBeenCalledTimes(1);

    // /about should have ISR entry
    const aboutEntry = await env.ASSETS.get(`${project.id}/isr/about`);
    expect(aboutEntry).not.toBeNull();

    // /private should NOT have ISR entry
    const privateEntry = await env.ASSETS.get(`${project.id}/isr/private`);
    expect(privateEntry).toBeNull();
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
            version: 1,
            bindings: {},
            revalidate: 3600,
            prerender: ["/"],
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    // Deployment should still be live despite prerender failure
    const dpl = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.project_id, project.id))
      .get();
    expect(dpl?.status).toBe("live");
  });

  it("sets prerendering status during prerender phase", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "prerender-status");

    let statusDuringPrerender: string | undefined;
    const dispatchGet = vi.fn().mockReturnValue({
      fetch: vi.fn().mockImplementation(async () => {
        // Check deployment status during prerender
        const dpl = await env.db
          .select({ status: deployments.status })
          .from(deployments)
          .where(eq(deployments.project_id, project.id))
          .get();
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
            version: 1,
            bindings: {},
            revalidate: 3600,
            prerender: ["/"],
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(statusDuringPrerender).toBe("prerendering");
  });
});
