import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import app from "../../src/index";
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /projects/:id/revalidate", () => {
  it("returns 401 without auth", async () => {
    const res = await app.fetch(
      new Request("http://localhost/projects/proj_fake/revalidate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 for nonexistent project", async () => {
    const user = await createTestUser(env.DB);

    const res = await app.fetch(
      new Request("http://localhost/projects/proj_nonexistent/revalidate", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ all: true }),
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 for non-owner", async () => {
    const owner = await createTestUser(env.DB, "owner");
    const other = await createTestUser(env.DB, "other");
    const project = await createTestProject(env.DB, owner.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${other.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ all: true }),
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 without paths or all", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
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

  it("purges specific paths from R2", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id);

    // Seed ISR cache entries
    await env.ASSETS.put(`${project.id}/isr/__index__`, "home", {
      customMetadata: { status: "200", createdAt: String(Date.now()), ttl: "60", headers: "{}" },
    });
    await env.ASSETS.put(`${project.id}/isr/about`, "about", {
      customMetadata: { status: "200", createdAt: String(Date.now()), ttl: "60", headers: "{}" },
    });
    await env.ASSETS.put(`${project.id}/isr/blog/hello`, "blog post", {
      customMetadata: { status: "200", createdAt: String(Date.now()), ttl: "60", headers: "{}" },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ paths: ["/", "/about"] }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { purged: number };
    expect(body.purged).toBe(2);

    // Verify purged entries are gone
    const home = await env.ASSETS.get(`${project.id}/isr/__index__`);
    expect(home).toBeNull();
    const about = await env.ASSETS.get(`${project.id}/isr/about`);
    expect(about).toBeNull();
    // blog/hello should still exist
    const blog = await env.ASSETS.get(`${project.id}/isr/blog/hello`);
    expect(blog).not.toBeNull();
  });

  it("purges all ISR entries with all: true", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id);

    // Seed ISR cache entries
    await env.ASSETS.put(`${project.id}/isr/__index__`, "home", {
      customMetadata: { status: "200", createdAt: String(Date.now()), ttl: "60", headers: "{}" },
    });
    await env.ASSETS.put(`${project.id}/isr/about`, "about", {
      customMetadata: { status: "200", createdAt: String(Date.now()), ttl: "60", headers: "{}" },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ all: true }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { purged: number };
    expect(body.purged).toBe(2);

    // Verify all ISR entries are gone
    const home = await env.ASSETS.get(`${project.id}/isr/__index__`);
    expect(home).toBeNull();
    const about = await env.ASSETS.get(`${project.id}/isr/about`);
    expect(about).toBeNull();
  });
});
