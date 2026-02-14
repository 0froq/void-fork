import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import app from "../../src/index";
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
  await clearTables(env.DB);
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
  form.append("manifest", JSON.stringify(opts?.manifest ?? { bindings: {} }));
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
    const user = await createTestUser(env.DB);
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
    const alice = await createTestUser(env.DB, "alice");
    const bob = await createTestUser(env.DB, "bob");
    const project = await createTestProject(env.DB, alice.id, "alice-app");
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
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id, "minimal-app");
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
    const dpl = await env.DB.prepare("SELECT status FROM deployments WHERE id = ?")
      .bind(body.deployment)
      .first<{ status: string }>();
    expect(dpl?.status).toBe("live");
  });

  it("stores assets in R2 at correct keys", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id, "asset-app");
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
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id, "routed-app");
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
    });
  });

  it("sends worker upload to correct CF API endpoint", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id, "worker-app");
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
    const uploadCall = fetchMock.mock.calls.find(
      (call: [string | URL | Request, RequestInit | undefined]) => {
        const url = typeof call[0] === "string" ? call[0] : call[0].toString();
        return url.includes("/workers/dispatch/") && call[1]?.method === "PUT";
      },
    );
    expect(uploadCall).toBeDefined();
    const uploadUrl =
      typeof uploadCall![0] === "string" ? uploadCall![0] : uploadCall![0].toString();
    expect(uploadUrl).toContain(
      `/accounts/${CF_ACCOUNT_ID}/workers/dispatch/namespaces/vite-cloud-users/scripts/user-worker-app`,
    );
  });

  it("provisions D1 when manifest requires it", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id, "d1-app");
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: { bindings: { d1: ["DB"] } },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    // Verify resource row was created in D1
    const resource = await env.DB.prepare(
      "SELECT * FROM resources WHERE project_id = ? AND type = 'd1'",
    )
      .bind(project.id)
      .first<{ cf_id: string; binding_name: string }>();
    expect(resource).not.toBeNull();
    expect(resource!.cf_id).toBe("d1-test-uuid");
    expect(resource!.binding_name).toBe("DB");
  });

  it("skips provisioning when resource already exists", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id, "existing-d1");
    const fetchMock = mockCfApi();

    // Pre-insert a resource
    await env.DB.prepare(
      "INSERT INTO resources (id, project_id, type, cf_id, binding_name) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("res_existing", project.id, "d1", "existing-d1-uuid", "DB")
      .run();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: { bindings: { d1: ["DB"] } },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    // Verify no D1 creation call was made
    const createD1Call = fetchMock.mock.calls.find(
      (call: [string | URL | Request, RequestInit | undefined]) => {
        const url = typeof call[0] === "string" ? call[0] : call[0].toString();
        return (
          url.includes("/d1/database") && !url.includes("/query") && call[1]?.method === "POST"
        );
      },
    );
    expect(createD1Call).toBeUndefined();
  });

  it("runs migrations before worker deploy", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id, "migrate-app");

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
          manifest: { bindings: { d1: ["DB"] } },
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
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id, "destructive-app");
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: { bindings: { d1: ["DB"] } },
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

    // Verify deployment is marked failed
    const dpl = await env.DB.prepare("SELECT status FROM deployments WHERE project_id = ?")
      .bind(project.id)
      .first<{ status: string }>();
    expect(dpl?.status).toBe("failed");
  });

  it("marks deployment failed when worker upload fails", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id, "fail-app");
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

    // Verify deployment is marked failed
    const dpl = await env.DB.prepare("SELECT status FROM deployments WHERE project_id = ?")
      .bind(project.id)
      .first<{ status: string }>();
    expect(dpl?.status).toBe("failed");
  });
});
