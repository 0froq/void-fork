import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { scheduled } from "../../src/index";
import { getUser, suspendUser } from "../../src/db";
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

const mockController = {} as ScheduledController;
const mockCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function makeBindings(e: TestEnv) {
  return {
    DB: e.DB,
    ASSETS: e.ASSETS,
    ROUTING: e.ROUTING,
    DISPATCH: e.DISPATCH,
    CF_API_TOKEN: e.CF_API_TOKEN,
    CF_ACCOUNT_ID: e.CF_ACCOUNT_ID,
    CF_ZONE_ID: e.CF_ZONE_ID,
    JWT_SECRET: e.JWT_SECRET,
    GITHUB_CLIENT_ID: e.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: e.GITHUB_CLIENT_SECRET,
    GOOGLE_CLIENT_ID: e.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: e.GOOGLE_CLIENT_SECRET,
  };
}

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
});

describe("scheduled()", () => {
  it("completes without error on empty database", async () => {
    mockCfApi();
    await scheduled(mockController, makeBindings(env), mockCtx);
    // No error thrown = pass
  });

  it("skips unlimited plan users (no analytics calls)", async () => {
    const fetchMock = mockCfApi();
    const { id } = await createTestUser(env.db, "sponsor", "github", undefined, "sponsored");
    const proj = await createTestProject(env.db, id);
    await env.ROUTING.put(proj.slug, JSON.stringify({ worker: "test" }));

    await scheduled(mockController, makeBindings(env), mockCtx);

    // No analytics calls should have been made
    const analyticsCalls = fetchMock.mock.calls.filter(
      (call) => call[0]?.includes("/analytics_engine/sql") && call[1]?.method === "POST",
    );
    expect(analyticsCalls).toHaveLength(0);

    // User should not be suspended
    const user = await getUser(env.db, id);
    expect(user!.suspended_reason).toBeNull();
  });

  it("skips users with no projects", async () => {
    const fetchMock = mockCfApi();
    await createTestUser(env.db, "noprojects", "github", undefined, "free");

    await scheduled(mockController, makeBindings(env), mockCtx);

    // No analytics calls
    const analyticsCalls = fetchMock.mock.calls.filter(
      (call) => call[0]?.includes("/analytics_engine/sql") && call[1]?.method === "POST",
    );
    expect(analyticsCalls).toHaveLength(0);
  });

  it("does not suspend user within limits", async () => {
    mockCfApi({
      analyticsQuery: () => Response.json({ data: [{ requests: 100, bandwidth_bytes: 0 }] }),
    });

    const { id } = await createTestUser(env.db, "withinlimits", "github", undefined, "free");
    const proj = await createTestProject(env.db, id);
    await env.ROUTING.put(proj.slug, JSON.stringify({ worker: "test" }));

    await scheduled(mockController, makeBindings(env), mockCtx);

    // User should not be suspended
    const user = await getUser(env.db, id);
    expect(user!.suspended_reason).toBeNull();

    // KV should not have suspended field
    const routing = JSON.parse((await env.ROUTING.get(proj.slug))!);
    expect(routing.suspended).toBeUndefined();
  });

  it("suspends user exceeding limits", async () => {
    // Free plan = 3M requests/month. Return 4M.
    mockCfApi({
      analyticsQuery: () => Response.json({ data: [{ requests: 4_000_000, bandwidth_bytes: 0 }] }),
    });

    const { id } = await createTestUser(env.db, "exceeded", "github", undefined, "free");
    const proj = await createTestProject(env.db, id);
    await env.ROUTING.put(proj.slug, JSON.stringify({ worker: "test" }));

    await scheduled(mockController, makeBindings(env), mockCtx);

    // User should be suspended in DB
    const user = await getUser(env.db, id);
    expect(user!.suspended_reason).toBe("requests_exceeded");

    // KV should have suspended field
    const routing = JSON.parse((await env.ROUTING.get(proj.slug))!);
    expect(routing.suspended).toBe("requests_exceeded");
  });

  it("unsuspends user previously exceeded, now within limits", async () => {
    mockCfApi({
      analyticsQuery: () => Response.json({ data: [{ requests: 100, bandwidth_bytes: 0 }] }),
    });

    const { id } = await createTestUser(env.db, "recovering", "github", undefined, "free");
    const proj = await createTestProject(env.db, id);

    // Pre-set as suspended due to requests exceeded
    await env.ROUTING.put(
      proj.slug,
      JSON.stringify({ worker: "test", suspended: "requests_exceeded" }),
    );
    await suspendUser(env.db, id, "requests_exceeded");

    await scheduled(mockController, makeBindings(env), mockCtx);

    // User should be unsuspended
    const user = await getUser(env.db, id);
    expect(user!.suspended_reason).toBeNull();

    // KV should not have suspended field
    const routing = JSON.parse((await env.ROUTING.get(proj.slug))!);
    expect(routing.suspended).toBeUndefined();
  });

  it("preserves admin-suspended user even when within limits (bug fix)", async () => {
    mockCfApi({
      analyticsQuery: () => Response.json({ data: [{ requests: 100, bandwidth_bytes: 0 }] }),
    });

    const { id } = await createTestUser(env.db, "adminsuspended", "github", undefined, "free");
    const proj = await createTestProject(env.db, id);

    // Admin suspended the user with a different reason
    await env.ROUTING.put(proj.slug, JSON.stringify({ worker: "test", suspended: "admin_action" }));
    await suspendUser(env.db, id, "admin_action");

    await scheduled(mockController, makeBindings(env), mockCtx);

    // User should STILL be suspended in DB
    const user = await getUser(env.db, id);
    expect(user!.suspended_reason).toBe("admin_action");

    // KV should STILL have admin suspension
    const routing = JSON.parse((await env.ROUTING.get(proj.slug))!);
    expect(routing.suspended).toBe("admin_action");
  });

  it("isolates errors — one user failure does not block others", async () => {
    let callCount = 0;
    mockCfApi({
      analyticsQuery: () => {
        callCount++;
        if (callCount <= 1) {
          // First user's analytics call throws
          throw new Error("API failure");
        }
        return Response.json({ data: [{ requests: 4_000_000, bandwidth_bytes: 0 }] });
      },
    });

    const { id: id1 } = await createTestUser(env.db, "user1", "github", undefined, "free");
    const proj1 = await createTestProject(env.db, id1);
    await env.ROUTING.put(proj1.slug, JSON.stringify({ worker: "test" }));

    const { id: id2 } = await createTestUser(env.db, "user2", "github", undefined, "free");
    const proj2 = await createTestProject(env.db, id2);
    await env.ROUTING.put(proj2.slug, JSON.stringify({ worker: "test" }));

    // Should not throw
    await scheduled(mockController, makeBindings(env), mockCtx);

    // Second user should still be processed and suspended
    const user2 = await getUser(env.db, id2);
    expect(user2!.suspended_reason).toBe("requests_exceeded");
  });

  it("processes multiple batches of users", async () => {
    // Create 55 users (> BATCH_SIZE of 50) each with one project, all exceeding limits
    mockCfApi({
      analyticsQuery: () => Response.json({ data: [{ requests: 4_000_000, bandwidth_bytes: 0 }] }),
    });

    const userIds: string[] = [];
    for (let i = 0; i < 55; i++) {
      const { id } = await createTestUser(env.db, `batchuser${i}`, "github", undefined, "free");
      const proj = await createTestProject(env.db, id);
      await env.ROUTING.put(proj.slug, JSON.stringify({ worker: "test" }));
      userIds.push(id);
    }

    await scheduled(mockController, makeBindings(env), mockCtx);

    // All 55 users should be suspended
    let suspendedCount = 0;
    for (const uid of userIds) {
      const user = await getUser(env.db, uid);
      if (user!.suspended_reason === "requests_exceeded") suspendedCount++;
    }
    expect(suspendedCount).toBe(55);
  });
});
