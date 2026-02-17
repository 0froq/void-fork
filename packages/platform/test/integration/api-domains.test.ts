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

describe("POST /projects/:id/domains", () => {
  it("adds a custom domain", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id, "domain-app");
    mockCfApi({
      createCustomHostname: () =>
        cfSuccess({
          id: "ch-123",
          hostname: "app.example.com",
          status: "pending",
          ssl: { status: "pending" },
        }),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: "app.example.com" }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      hostname: string;
      status: string;
      cname_target: string;
    };
    expect(body.id).toMatch(/^dom_/);
    expect(body.hostname).toBe("app.example.com");
    expect(body.status).toBe("pending");
    expect(body.cname_target).toBe("cname.vitecloud.app");
  });

  it("returns 404 for non-existent project", async () => {
    const user = await createTestUser(env.DB);
    mockCfApi();

    const res = await app.fetch(
      new Request("http://localhost/projects/proj_nonexistent/domains", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: "app.example.com" }),
      }),
      env,
    );

    expect(res.status).toBe(404);
  });

  it("returns 403 when user does not own project", async () => {
    const alice = await createTestUser(env.DB, "alice");
    const bob = await createTestUser(env.DB, "bob");
    const project = await createTestProject(env.DB, alice.id, "alice-domain");
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bob.jwt}`,
        },
        body: JSON.stringify({ hostname: "app.example.com" }),
      }),
      env,
    );

    expect(res.status).toBe(403);
  });

  it("returns 409 for duplicate hostname", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id, "dup-domain");
    mockCfApi({
      createCustomHostname: () =>
        cfSuccess({
          id: "ch-dup",
          hostname: "taken.example.com",
          status: "pending",
          ssl: { status: "pending" },
        }),
    });

    // Insert existing domain
    await env.DB.prepare(
      "INSERT INTO domains (id, project_id, hostname, cf_hostname_id) VALUES (?, ?, ?, ?)",
    )
      .bind("dom_existing", project.id, "taken.example.com", "ch-existing")
      .run();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: "taken.example.com" }),
      }),
      env,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "hostname already in use" });
  });

  it("rejects vitecloud.app subdomains", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id, "reject-vc");
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: "bad.vitecloud.app" }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "cannot use vitecloud.app subdomains" });
  });

  it("rejects invalid hostname format", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id, "invalid-host");
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: "not a hostname" }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid hostname format" });
  });
});

describe("GET /projects/:id/domains", () => {
  it("lists domains for a project", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id, "list-domain");

    await env.DB.prepare(
      "INSERT INTO domains (id, project_id, hostname, cf_hostname_id, status) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("dom_1", project.id, "a.example.com", "ch-1", "active")
      .run();
    await env.DB.prepare(
      "INSERT INTO domains (id, project_id, hostname, cf_hostname_id, status) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("dom_2", project.id, "b.example.com", "ch-2", "pending")
      .run();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { hostname: string; status: string }[];
    expect(body).toHaveLength(2);
    expect(body[0].hostname).toBe("a.example.com");
    expect(body[1].hostname).toBe("b.example.com");
  });
});

describe("GET /projects/:id/domains/:domainId", () => {
  it("returns domain status from CF API", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id, "status-domain");
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: "ch-status",
          hostname: "status.example.com",
          status: "pending",
          ssl: { status: "pending_validation" },
        }),
    });

    await env.DB.prepare(
      "INSERT INTO domains (id, project_id, hostname, cf_hostname_id, status) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("dom_status", project.id, "status.example.com", "ch-status", "pending")
      .run();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_status`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hostname: string;
      status: string;
      ssl_status: string;
    };
    expect(body.hostname).toBe("status.example.com");
    expect(body.status).toBe("pending");
    expect(body.ssl_status).toBe("pending_validation");
  });

  it("activates domain and writes KV when CF reports active", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id, "activate-domain");
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: "ch-active",
          hostname: "active.example.com",
          status: "active",
          ssl: { status: "active" },
        }),
    });

    await env.DB.prepare(
      "INSERT INTO domains (id, project_id, hostname, cf_hostname_id, status) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("dom_activate", project.id, "active.example.com", "ch-active", "pending")
      .run();

    // Seed KV routing for the slug
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: "user-activate-domain", projectId: project.id }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_activate`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("active");

    // Verify DB was updated
    const row = await env.DB.prepare("SELECT status FROM domains WHERE id = ?")
      .bind("dom_activate")
      .first<{ status: string }>();
    expect(row?.status).toBe("active");

    // Verify KV routing entry was written
    const domainRouting = await env.ROUTING.get("domain:active.example.com", "json");
    expect(domainRouting).toEqual({
      workerName: "user-activate-domain",
      projectId: project.id,
    });
  });
});

describe("DELETE /projects/:id/domains/:domainId", () => {
  it("removes a custom domain", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id, "remove-domain");
    const fetchMock = mockCfApi();

    await env.DB.prepare(
      "INSERT INTO domains (id, project_id, hostname, cf_hostname_id, status) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("dom_remove", project.id, "remove.example.com", "ch-remove", "active")
      .run();

    // Seed KV routing for the domain
    await env.ROUTING.put("domain:remove.example.com", JSON.stringify({ projectId: project.id }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_remove`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // Verify DB record deleted
    const row = await env.DB.prepare("SELECT * FROM domains WHERE id = ?")
      .bind("dom_remove")
      .first();
    expect(row).toBeNull();

    // Verify KV routing entry deleted
    const domainRouting = await env.ROUTING.get("domain:remove.example.com");
    expect(domainRouting).toBeNull();

    // Verify CF API was called
    const deleteCall = fetchMock.mock.calls.find((call: unknown[]) => {
      const url = typeof call[0] === "string" ? call[0] : String(call[0]);
      return (
        url.includes("/custom_hostnames/ch-remove") && (call[1] as RequestInit)?.method === "DELETE"
      );
    });
    expect(deleteCall).toBeDefined();
  });

  it("returns 404 for non-existent domain", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id, "no-domain");
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_nonexistent`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(404);
  });
});
