import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import app from "../../src/index";
import { hmacSignState } from "../../src/auth/hmac";
import { eq } from "drizzle-orm";
import { users } from "../../src/schema";
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  seedOAuthNonce,
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
  await clearTables(env.db);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function buildSignedState(provider: string): Promise<string> {
  const redirect = "http://localhost:9999/callback";
  const stateData = JSON.stringify({ redirect, nonce: "test-nonce", provider });
  const stateEncoded = btoa(stateData);
  const signature = await hmacSignState(stateEncoded, JWT_SECRET);
  return `${stateEncoded}.${signature}`;
}

function mockGitHubApi(ghUser: {
  id: number;
  login: string;
  email: string | null;
  emailVerified: boolean;
  publicEmail?: boolean;
}) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes("github.com/login/oauth/access_token")) {
      return Response.json({ access_token: "test-gh-token" });
    }

    if (url === "https://api.github.com/user") {
      return Response.json({
        id: ghUser.id,
        login: ghUser.login,
        email: ghUser.publicEmail ? ghUser.email : null,
      });
    }

    if (url === "https://api.github.com/user/emails") {
      if (ghUser.email) {
        return Response.json([
          { email: ghUser.email, primary: true, verified: ghUser.emailVerified },
        ]);
      }
      return Response.json([]);
    }

    throw new Error(`Unmocked fetch: ${url}`);
  });
}

describe("email verification gating on account linking", () => {
  it("does not link to existing account when GitHub email is unverified", async () => {
    const existing = await createTestUser(env.db, "existing-user");
    await env.db
      .update(users)
      .set({ email: "shared@example.com" })
      .where(eq(users.id, existing.id));

    const state = await buildSignedState("github");
    await seedOAuthNonce(env.db, "test-nonce");
    vi.stubGlobal(
      "fetch",
      mockGitHubApi({
        id: 99999,
        login: "new-gh-user",
        email: "shared@example.com",
        emailVerified: false,
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`),
      env,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("Location")!;
    const token = new URL(location).searchParams.get("token")!;

    const { verifyJwt } = await import("../../src/auth/jwt");
    const payload = await verifyJwt(token, JWT_SECRET);
    expect(payload).toBeDefined();
    expect(payload!.sub).not.toBe(existing.id);
  });

  it("links to existing account when GitHub has public email that is verified", async () => {
    const existing = await createTestUser(env.db, "public-email-user");
    await env.db
      .update(users)
      .set({ email: "public@example.com" })
      .where(eq(users.id, existing.id));

    const state = await buildSignedState("github");
    await seedOAuthNonce(env.db, "test-nonce");
    vi.stubGlobal(
      "fetch",
      mockGitHubApi({
        id: 77777,
        login: "public-email-gh-user",
        email: "public@example.com",
        emailVerified: true,
        publicEmail: true,
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`),
      env,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("Location")!;
    const token = new URL(location).searchParams.get("token")!;

    const { verifyJwt } = await import("../../src/auth/jwt");
    const payload = await verifyJwt(token, JWT_SECRET);
    expect(payload).toBeDefined();
    expect(payload!.sub).toBe(existing.id);
  });

  it("links to existing account when GitHub email is verified (private email)", async () => {
    const existing = await createTestUser(env.db, "linkable-user");
    await env.db
      .update(users)
      .set({ email: "verified@example.com" })
      .where(eq(users.id, existing.id));

    const state = await buildSignedState("github");
    await seedOAuthNonce(env.db, "test-nonce");
    vi.stubGlobal(
      "fetch",
      mockGitHubApi({
        id: 88888,
        login: "verified-gh-user",
        email: "verified@example.com",
        emailVerified: true,
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`),
      env,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("Location")!;
    const token = new URL(location).searchParams.get("token")!;

    const { verifyJwt } = await import("../../src/auth/jwt");
    const payload = await verifyJwt(token, JWT_SECRET);
    expect(payload).toBeDefined();
    expect(payload!.sub).toBe(existing.id);
  });
});
