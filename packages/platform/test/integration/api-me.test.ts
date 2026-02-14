import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import app from "../../src/index";
import { signJwt } from "../../src/auth/jwt";
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  JWT_SECRET,
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

describe("GET /me", () => {
  it("returns 401 without auth header", async () => {
    const res = await app.fetch(new Request("http://localhost/me"), env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 401 with invalid JWT", async () => {
    const res = await app.fetch(
      new Request("http://localhost/me", {
        headers: { Authorization: "Bearer not-a-real-jwt" },
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "invalid or expired token",
    });
  });

  it("returns 401 with expired JWT", async () => {
    // Insert user with real timers
    const userId = "user_expired";
    await env.DB.prepare(
      "INSERT INTO users (id, github_id, github_login, email) VALUES (?, ?, ?, ?)",
    )
      .bind(userId, 99999, "expired", null)
      .run();

    // Sign JWT in the past so it's expired
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01"));
    const jwt = await signJwt({ sub: userId, login: "expired" }, JWT_SECRET);
    vi.useRealTimers();

    const res = await app.fetch(
      new Request("http://localhost/me", {
        headers: { Authorization: `Bearer ${jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("returns user login with valid JWT", async () => {
    const user = await createTestUser(env.DB, "alice");

    const res = await app.fetch(
      new Request("http://localhost/me", {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ login: "alice" });
  });
});
