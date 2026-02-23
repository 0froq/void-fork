import { describe, it, expect, beforeAll, afterAll } from "vitest";
import app from "../../src/index";
import { setupEnv, teardownEnv, type TestEnv } from "./helpers";

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await app.fetch(new Request("http://localhost/health"), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
