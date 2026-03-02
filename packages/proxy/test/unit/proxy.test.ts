import { describe, it, expect, vi, beforeAll } from "vitest";
import worker from "../../src/index";

const JWT_SECRET = "test-secret-key";

// --- JWT helper (mirrors the worker's HMAC-SHA256 signing) ---

function base64urlEncode(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signJwt(
  payload: { sub: string; login: string; exp?: number },
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const header = base64urlEncode(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = base64urlEncode(
    encoder.encode(
      JSON.stringify({
        ...payload,
        iat: Math.floor(Date.now() / 1000),
        exp: payload.exp ?? Math.floor(Date.now() / 1000) + 3600,
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${header}.${body}`)),
  );
  return `${header}.${body}.${base64urlEncode(sig)}`;
}

// --- HMAC helper (mirrors the worker's project token signing) ---

async function signAiToken(projectId: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(projectId)));
  return base64urlEncode(sig);
}

// --- Mock env factory ---

interface MockAi {
  run: ReturnType<typeof vi.fn>;
  models: ReturnType<typeof vi.fn>;
  toMarkdown: ReturnType<typeof vi.fn>;
}

function createMockKv(data: Record<string, string> = {}) {
  return {
    get: vi.fn(async (key: string) => data[key] ?? null),
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
}

function createMockApi(handler?: (req: Request) => Promise<Response>) {
  return {
    fetch:
      handler ??
      vi.fn(
        async () =>
          new Response(JSON.stringify({ purged: 1 }), {
            headers: { "content-type": "application/json" },
          }),
      ),
  };
}

function createEnv(
  aiOverrides?: Partial<MockAi>,
  kvData?: Record<string, string>,
  apiOverride?: { fetch: ReturnType<typeof vi.fn> | ((req: Request) => Promise<Response>) },
) {
  return {
    AI: {
      run: vi.fn(async () => ({ response: "hello" })),
      models: vi.fn(async () => [{ name: "model-a" }]),
      toMarkdown: vi.fn(async () => ({ markdown: "# Hi" })),
      ...aiOverrides,
    },
    JWT_SECRET,
    ROUTING: createMockKv(kvData),
    DB: {} as any,
    CF_ACCOUNT_ID: "test-account-id",
    CF_API_TOKEN: "test-api-token",
    API: apiOverride ?? createMockApi(),
  };
}

function post(path: string, body: unknown, headers?: Record<string, string>): Request {
  return new Request(`https://proxy.void.cloud${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// --- Tests ---

describe("proxy worker", () => {
  let validToken: string;
  const aiTokens: Record<string, string> = {};

  beforeAll(async () => {
    validToken = await signJwt({ sub: "user_1", login: "testuser" }, JWT_SECRET);
    for (const pid of ["proj_1", "proj_42", "proj_99", "p"]) {
      aiTokens[pid] = await signAiToken(pid, JWT_SECRET);
    }
  });

  describe("CORS", () => {
    it("returns 204 with CORS headers on OPTIONS", async () => {
      const req = new Request("https://proxy.void.cloud/ai/run", { method: "OPTIONS" });
      const res = await worker.fetch(req, createEnv());

      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toContain("POST");
      expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
    });
  });

  describe("method validation", () => {
    it("rejects non-POST requests with 405", async () => {
      const req = new Request("https://proxy.void.cloud/ai/run", { method: "GET" });
      const res = await worker.fetch(req, createEnv());

      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({ error: "method not allowed" });
    });
  });

  describe("JWT authentication (HTTPS path)", () => {
    it("accepts valid JWT", async () => {
      const env = createEnv();
      const res = await worker.fetch(
        post(
          "/ai/run",
          { model: "test-model", inputs: {}, projectId: "proj_1" },
          { authorization: `Bearer ${validToken}` },
        ),
        env,
      );

      expect(res.status).toBe(200);
      expect(env.AI.run).toHaveBeenCalled();
    });

    it("rejects expired JWT with 401", async () => {
      const expiredToken = await signJwt(
        { sub: "user_1", login: "testuser", exp: Math.floor(Date.now() / 1000) - 60 },
        JWT_SECRET,
      );

      const res = await worker.fetch(
        post(
          "/ai/run",
          { model: "m", inputs: {}, projectId: "p" },
          { authorization: `Bearer ${expiredToken}` },
        ),
        createEnv(),
      );

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid or expired token" });
    });

    it("rejects JWT signed with wrong secret", async () => {
      const badToken = await signJwt({ sub: "user_1", login: "testuser" }, "wrong-secret");

      const res = await worker.fetch(
        post(
          "/ai/run",
          { model: "m", inputs: {}, projectId: "p" },
          { authorization: `Bearer ${badToken}` },
        ),
        createEnv(),
      );

      expect(res.status).toBe(401);
    });

    it("rejects malformed JWT with 401", async () => {
      const res = await worker.fetch(
        post(
          "/ai/run",
          { model: "m", inputs: {}, projectId: "p" },
          { authorization: "Bearer not.a.valid.jwt.at.all" },
        ),
        createEnv(),
      );

      expect(res.status).toBe(401);
    });

    it("requires projectId with JWT auth", async () => {
      const res = await worker.fetch(
        post("/ai/run", { model: "m", inputs: {} }, { authorization: `Bearer ${validToken}` }),
        createEnv(),
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "projectId required" });
    });
  });

  describe("service binding path (no auth header)", () => {
    it("accepts requests with valid aiToken", async () => {
      const env = createEnv();
      const res = await worker.fetch(
        post("/ai/run", {
          model: "test-model",
          inputs: {},
          projectId: "proj_1",
          aiToken: aiTokens["proj_1"],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(env.AI.run).toHaveBeenCalled();
    });

    it("requires projectId and aiToken", async () => {
      const res = await worker.fetch(post("/ai/run", { model: "m", inputs: {} }), createEnv());

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "projectId and aiToken required" });
    });

    it("rejects request with missing aiToken", async () => {
      const res = await worker.fetch(
        post("/ai/run", { model: "m", inputs: {}, projectId: "proj_1" }),
        createEnv(),
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "projectId and aiToken required" });
    });

    it("rejects request with wrong aiToken", async () => {
      const res = await worker.fetch(
        post("/ai/run", {
          model: "m",
          inputs: {},
          projectId: "proj_1",
          aiToken: "invalid-token",
        }),
        createEnv(),
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "invalid project token" });
    });

    it("rejects request with aiToken for different projectId", async () => {
      const res = await worker.fetch(
        post("/ai/run", {
          model: "m",
          inputs: {},
          projectId: "proj_1",
          aiToken: aiTokens["proj_42"],
        }),
        createEnv(),
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "invalid project token" });
    });
  });

  describe("AI usage limit (KV block)", () => {
    it("returns 429 when ai-block key exists (service binding path)", async () => {
      const env = createEnv({}, { "ai-block:proj_1": "1" });
      const res = await worker.fetch(
        post("/ai/run", {
          model: "m",
          inputs: {},
          projectId: "proj_1",
          aiToken: aiTokens["proj_1"],
        }),
        env,
      );

      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: "AI usage limit exceeded" });
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("returns 429 when ai-block key exists (JWT path)", async () => {
      const env = createEnv({}, { "ai-block:proj_1": "1" });
      const res = await worker.fetch(
        post(
          "/ai/run",
          { model: "m", inputs: {}, projectId: "proj_1" },
          { authorization: `Bearer ${validToken}` },
        ),
        env,
      );

      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: "AI usage limit exceeded" });
    });

    it("allows request when ai-block key does not exist", async () => {
      const env = createEnv({}, {});
      const res = await worker.fetch(
        post("/ai/run", {
          model: "m",
          inputs: {},
          projectId: "proj_1",
          aiToken: aiTokens["proj_1"],
        }),
        env,
      );

      expect(res.status).toBe(200);
    });
  });

  describe("AI: /ai/run", () => {
    it("calls AI.run with model, inputs, and gateway metadata", async () => {
      const env = createEnv();
      const res = await worker.fetch(
        post("/ai/run", {
          model: "@cf/meta/llama-3-8b-instruct",
          inputs: { prompt: "hi" },
          options: { max_tokens: 100 },
          projectId: "proj_42",
          aiToken: aiTokens["proj_42"],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(env.AI.run).toHaveBeenCalledWith(
        "@cf/meta/llama-3-8b-instruct",
        { prompt: "hi" },
        {
          max_tokens: 100,
          gateway: { id: "void", metadata: { projectId: "proj_42" } },
        },
      );
    });

    it("returns 400 when model is missing", async () => {
      const res = await worker.fetch(
        post("/ai/run", { inputs: {}, projectId: "p", aiToken: aiTokens["p"] }),
        createEnv(),
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "model required" });
    });

    it("returns streaming response when inputs.stream is true", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"response":"hi"}\n\n'));
          controller.close();
        },
      });
      const env = createEnv({ run: vi.fn(async () => stream) });

      const res = await worker.fetch(
        post("/ai/run", {
          model: "m",
          inputs: { prompt: "hi", stream: true },
          projectId: "p",
          aiToken: aiTokens["p"],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      expect(res.headers.get("cache-control")).toBe("no-cache");

      const text = await res.text();
      expect(text).toContain('{"response":"hi"}');
    });

    it("returns JSON response for non-streaming calls", async () => {
      const env = createEnv({ run: vi.fn(async () => ({ response: "world" })) });

      const res = await worker.fetch(
        post("/ai/run", {
          model: "m",
          inputs: { prompt: "hi" },
          projectId: "p",
          aiToken: aiTokens["p"],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ response: "world" });
    });

    it("injects gateway metadata even without user options", async () => {
      const env = createEnv();
      await worker.fetch(
        post("/ai/run", {
          model: "m",
          inputs: {},
          projectId: "proj_99",
          aiToken: aiTokens["proj_99"],
        }),
        env,
      );

      expect(env.AI.run).toHaveBeenCalledWith(
        "m",
        {},
        {
          gateway: { id: "void", metadata: { projectId: "proj_99" } },
        },
      );
    });
  });

  describe("AI: /ai/models", () => {
    it("calls AI.models and returns result", async () => {
      const models = [{ name: "model-a" }, { name: "model-b" }];
      const env = createEnv({ models: vi.fn(async () => models) });

      const res = await worker.fetch(
        post("/ai/models", {
          inputs: { search: "llama" },
          projectId: "p",
          aiToken: aiTokens["p"],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(models);
      expect(env.AI.models).toHaveBeenCalledWith({ search: "llama" });
    });
  });

  describe("AI: /ai/toMarkdown", () => {
    it("calls AI.toMarkdown and returns result", async () => {
      const result = { markdown: "# Hello" };
      const env = createEnv({ toMarkdown: vi.fn(async () => result) });

      const res = await worker.fetch(
        post("/ai/toMarkdown", {
          inputs: { content: "hello" },
          options: { format: "md" },
          projectId: "p",
          aiToken: aiTokens["p"],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(result);
      expect(env.AI.toMarkdown).toHaveBeenCalledWith({ content: "hello" }, { format: "md" });
    });
  });

  describe("revalidate: /revalidate", () => {
    it("forwards revalidation to API via service binding", async () => {
      const apiFetch = vi.fn(
        async () =>
          new Response(JSON.stringify({ purged: 2 }), {
            headers: { "content-type": "application/json" },
          }),
      );
      const env = createEnv({}, {}, { fetch: apiFetch });

      const res = await worker.fetch(
        post("/revalidate", {
          paths: ["/", "/blog"],
          projectId: "proj_1",
          aiToken: aiTokens["proj_1"],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ purged: 2 });

      expect(apiFetch).toHaveBeenCalledOnce();
      // Fetcher.fetch() receives (url: string, init: RequestInit)
      const [url, init] = apiFetch.mock.calls[0];
      expect(url).toBe("https://api/internal/revalidate/proj_1");
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("x-void-internal")).toBe(aiTokens["proj_1"]);
      expect(JSON.parse(init.body)).toEqual({ paths: ["/", "/blog"] });
    });

    it("forwards all:true revalidation", async () => {
      const apiFetch = vi.fn(
        async () =>
          new Response(JSON.stringify({ purged: 10 }), {
            headers: { "content-type": "application/json" },
          }),
      );
      const env = createEnv({}, {}, { fetch: apiFetch });

      const res = await worker.fetch(
        post("/revalidate", {
          all: true,
          projectId: "proj_1",
          aiToken: aiTokens["proj_1"],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ purged: 10 });

      const [, init] = apiFetch.mock.calls[0];
      expect(JSON.parse(init.body)).toEqual({ all: true });
    });

    it("rejects unauthenticated revalidation requests", async () => {
      const res = await worker.fetch(post("/revalidate", { paths: ["/"] }), createEnv());

      expect(res.status).toBe(400);
    });
  });

  describe("error handling", () => {
    it("returns 502 when AI binding throws", async () => {
      const env = createEnv({
        run: vi.fn(async () => {
          throw new Error("inference failed");
        }),
      });

      const res = await worker.fetch(
        post("/ai/run", {
          model: "m",
          inputs: {},
          projectId: "p",
          aiToken: aiTokens["p"],
        }),
        env,
      );

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "inference error" });
    });

    it("returns 502 with generic error when non-Error is thrown", async () => {
      const env = createEnv({
        run: vi.fn(async () => {
          throw "string error";
        }),
      });

      const res = await worker.fetch(
        post("/ai/run", {
          model: "m",
          inputs: {},
          projectId: "p",
          aiToken: aiTokens["p"],
        }),
        env,
      );

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "inference error" });
    });

    it("includes CORS headers on error responses", async () => {
      const env = createEnv({
        run: vi.fn(async () => {
          throw new Error("fail");
        }),
      });

      const res = await worker.fetch(
        post("/ai/run", {
          model: "m",
          inputs: {},
          projectId: "p",
          aiToken: aiTokens["p"],
        }),
        env,
      );

      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });
  });
});
