import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
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

describe("project secrets API", () => {
  it("returns 401 without auth", async () => {
    const res = await app.fetch(
      new Request("http://localhost/projects/proj_x/secrets/API_KEY", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "secret" }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("sets a secret for owned project", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id, "secret-app");
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/secrets/API_KEY`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: "top-secret" }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "API_KEY" });

    const call = fetchMock.mock.calls.find((c) => {
      const method = (c[1] as RequestInit | undefined)?.method;
      const url = typeof c[0] === "string" ? c[0] : String(c[0]);
      return method === "PUT" && url.includes("/secrets");
    });
    expect(call).toBeDefined();
  });

  it("deletes a secret for owned project", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id, "secret-delete-app");
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/secrets/API_KEY`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${user.jwt}`,
        },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "API_KEY" });

    const call = fetchMock.mock.calls.find((c) => {
      const method = (c[1] as RequestInit | undefined)?.method;
      const url = typeof c[0] === "string" ? c[0] : String(c[0]);
      return method === "DELETE" && url.includes("/secrets/API_KEY");
    });
    expect(call).toBeDefined();
  });

  it("returns 403 for non-owner", async () => {
    const alice = await createTestUser(env.DB, "alice");
    const bob = await createTestUser(env.DB, "bob");
    const project = await createTestProject(env.DB, alice.id, "alice-secret-app");
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/secrets/API_KEY`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${bob.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: "nope" }),
      }),
      env,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("validates secret name", async () => {
    const user = await createTestUser(env.DB);
    const project = await createTestProject(env.DB, user.id, "secret-name-app");
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/secrets/not-valid`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: "x" }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid secret name" });
  });
});
