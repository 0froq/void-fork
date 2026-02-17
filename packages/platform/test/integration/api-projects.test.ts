import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import app from "../../src/index";
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
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
  await clearTables(env.DB);
});

describe("GET /projects", () => {
  it("returns 401 without auth", async () => {
    const res = await app.fetch(new Request("http://localhost/projects"), env);
    expect(res.status).toBe(401);
  });

  it("returns empty array when no projects", async () => {
    const user = await createTestUser(env.DB);

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
    const alice = await createTestUser(env.DB, "alice");
    const bob = await createTestUser(env.DB, "bob");
    await createTestProject(env.DB, alice.id, "alice-app");
    await createTestProject(env.DB, bob.id, "bob-app");

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

describe("POST /projects", () => {
  it("creates project with valid slug", async () => {
    const user = await createTestUser(env.DB);

    const res = await app.fetch(
      new Request("http://localhost/projects", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ slug: "my-app", name: "My App" }),
      }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      slug: string;
      name: string;
      user_id: string;
    };
    expect(body.slug).toBe("my-app");
    expect(body.name).toBe("My App");
    expect(body.user_id).toBe(user.id);
  });

  it("rejects missing slug", async () => {
    const user = await createTestUser(env.DB);

    const res = await app.fetch(
      new Request("http://localhost/projects", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "No Slug" }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("rejects invalid slug format", async () => {
    const user = await createTestUser(env.DB);

    const res = await app.fetch(
      new Request("http://localhost/projects", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          slug: "UPPER-CASE",
          name: "Bad Slug",
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "slug must be lowercase alphanumeric with dashes",
    });
  });

  it("rejects duplicate slug", async () => {
    const user = await createTestUser(env.DB);
    await createTestProject(env.DB, user.id, "taken-slug");

    const res = await app.fetch(
      new Request("http://localhost/projects", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ slug: "taken-slug", name: "Dup" }),
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
    const user = await createTestUser(env.DB);

    const res = await app.fetch(
      new Request("http://localhost/projects/proj_nonexistent/deployments", {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when not the project owner", async () => {
    const alice = await createTestUser(env.DB, "alice");
    const bob = await createTestUser(env.DB, "bob");
    const project = await createTestProject(env.DB, alice.id, "alice-project");

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deployments`, {
        headers: { Authorization: `Bearer ${bob.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it("returns empty array when no deployments", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id);

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
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id);

    const d1 = await createDeployment(env.DB, project.id, null, "manual");
    await updateDeploymentStatus(env.DB, d1.id, "live");
    const d2 = await createDeployment(env.DB, project.id, null, "ci");

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
