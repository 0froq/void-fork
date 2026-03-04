import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import app from "../../src/index";
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  mockCfApi,
  type TestEnv,
} from "./helpers";
import { createDeployment, updateDeploymentStatus } from "../../src/db";

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

describe("GET /projects", () => {
  it("returns 401 without auth", async () => {
    const res = await app.fetch(new Request("http://localhost/projects"), env);
    expect(res.status).toBe(401);
  });

  it("returns empty array when no projects", async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request("http://localhost/projects", {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns only the authenticated user's projects", async () => {
    const alice = await createTestUser(env.db, "alice");
    const bob = await createTestUser(env.db, "bob");
    await createTestProject(env.db, alice.id, "alice-app");
    await createTestProject(env.db, bob.id, "bob-app");

    const res = await app.fetch(
      new Request("http://localhost/projects", {
        headers: { Authorization: `Bearer ${alice.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const projects = (await res.json()) as { slug: string }[];
    expect(projects).toHaveLength(1);
    expect(projects[0].slug).toBe("alice-app");
  });
});

describe("GET /projects/:id", () => {
  it("returns project for the owner", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "my-app");

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; slug: string };
    expect(body.id).toBe(project.id);
    expect(body.slug).toBe("my-app");
  });

  it("returns 403 when user does not own the project", async () => {
    const alice = await createTestUser(env.db, "alice");
    const bob = await createTestUser(env.db, "bob");
    const project = await createTestProject(env.db, alice.id, "alice-app");

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        headers: { Authorization: `Bearer ${bob.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("returns 404 for nonexistent project", async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request("http://localhost/projects/proj_nonexistent", {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /projects", () => {
  it("creates project with valid slug", async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request("http://localhost/projects", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ slug: "my-app" }),
      }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      slug: string;
      user_id: string;
    };
    expect(body.slug).toBe("my-app");
    expect(body.user_id).toBe(user.id);
  });

  it("rejects missing slug", async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request("http://localhost/projects", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("rejects invalid slug format", async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request("http://localhost/projects", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ slug: "UPPER-CASE" }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "slug must be lowercase alphanumeric with dashes",
    });
  });

  it("rejects short slug for free tier users", async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request("http://localhost/projects", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ slug: "abc" }),
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "short slugs (5 characters or fewer) require a paid plan",
    });
  });

  it("allows short slug for paid tier users", async () => {
    const user = await createTestUser(env.db, "paiduser", "github", undefined, "solo");

    const res = await app.fetch(
      new Request("http://localhost/projects", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ slug: "abc" }),
      }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { slug: string };
    expect(body.slug).toBe("abc");
  });

  it("rejects duplicate slug", async () => {
    const user = await createTestUser(env.db);
    await createTestProject(env.db, user.id, "taken-slug");

    const res = await app.fetch(
      new Request("http://localhost/projects", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ slug: "taken-slug" }),
      }),
      env,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "slug already taken" });
  });
});

describe("GET /projects/:id/deployments", () => {
  it("returns 401 without auth", async () => {
    const res = await app.fetch(
      new Request("http://localhost/projects/proj_test1/deployments"),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 for nonexistent project", async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request("http://localhost/projects/proj_nonexistent/deployments", {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when not the project owner", async () => {
    const alice = await createTestUser(env.db, "alice");
    const bob = await createTestUser(env.db, "bob");
    const project = await createTestProject(env.db, alice.id, "alice-project");

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deployments`, {
        headers: { Authorization: `Bearer ${bob.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it("returns empty array when no deployments", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deployments`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns deployments with source field", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const d1 = await createDeployment(env.db, project.id, null, "manual");
    await updateDeploymentStatus(env.db, d1.id, "live");
    const d2 = await createDeployment(env.db, project.id, null, "ci");

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deployments`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const deployments = (await res.json()) as {
      id: string;
      source: string | null;
      status: string;
    }[];
    expect(deployments).toHaveLength(2);

    const byId = Object.fromEntries(deployments.map((d) => [d.id, d]));
    expect(byId[d1.id].source).toBe("manual");
    expect(byId[d1.id].status).toBe("live");
    expect(byId[d2.id].source).toBe("ci");
    expect(byId[d2.id].status).toBe("pending");
  });
});

describe("GET /projects/:id/logs", () => {
  it("returns 401 without auth", async () => {
    const res = await app.fetch(new Request("http://localhost/projects/fake-id/logs"), env);
    expect(res.status).toBe(401);
  });

  it("returns 404 for nonexistent project", async () => {
    const user = await createTestUser(env.db);
    const res = await app.fetch(
      new Request("http://localhost/projects/nonexistent/logs", {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 for another user's project", async () => {
    const alice = await createTestUser(env.db, "alice");
    const bob = await createTestUser(env.db, "bob");
    const project = await createTestProject(env.db, alice.id, "alice-logs");

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs`, {
        headers: { Authorization: `Bearer ${bob.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it("returns log data from analytics engine", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "my-app");

    const mockData = {
      data: [
        {
          outcome: "ok",
          logData: JSON.stringify([{ level: "log", message: ["hello"], timestamp: 1000 }]),
          exceptionData: "[]",
          url: "https://my-app.void.app/api/test",
          method: "GET",
          statusCode: "200",
          ts: Date.now() - 5000,
        },
      ],
    };

    mockCfApi({
      analyticsQuery: (_url, init) => {
        const body = typeof init?.body === "string" ? init.body : "";
        expect(body).toContain("user-my-app");
        return Response.json(mockData);
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { outcome: string; url: string }[] };
    expect(json.data).toHaveLength(1);
    expect(json.data[0]).toMatchObject({
      outcome: "ok",
      url: "https://my-app.void.app/api/test",
      method: "GET",
      status: "200",
    });
  });

  it("rejects invalid since parameter", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, "bad-since");

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs?since=abc`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(400);
  });
});
