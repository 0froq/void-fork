# Multi-Provider AI (BYOK) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend `void/ai` to support third-party AI providers (OpenAI, Anthropic, etc.) via BYOK, routing through CF AI Gateway's unified endpoint for automatic metering.

**Architecture:** Third-party models (detected by `provider/model` prefix) route through a new `/ai/chat` proxy endpoint that forwards to CF AI Gateway's OpenAI-compatible `/compat/chat/completions` endpoint. Workers AI models (`@cf/...`) continue using the existing `env.AI.run()` path unchanged. User API keys come from project secrets (env bindings).

**Tech Stack:** Hono (proxy), CF AI Gateway `/compat` endpoint, TypeScript template literal types for overload inference

**Design Doc:** `meta/design-docs/0049-multi-provider-ai.md`

---

### Task 1: Add `CF_AIG_TOKEN` to proxy types

**Files:**

- Modify: `packages/proxy/src/types.ts`
- Modify: `packages/proxy/wrangler.jsonc`

**Step 1: Add `CF_AIG_TOKEN` to the `Env` interface**

In `packages/proxy/src/types.ts`, add `CF_AIG_TOKEN` to the `Env` interface:

```typescript
export interface Env {
  AI: Ai;
  JWT_SECRET: string;
  ROUTING: KVNamespace;
  DB: D1Database;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  CF_AIG_TOKEN: string; // <-- new: AI Gateway authentication token
  API: Fetcher;
}
```

**Step 2: Update wrangler.jsonc secrets comment**

In `packages/proxy/wrangler.jsonc`, update the secrets comment:

```jsonc
// Secrets (via `wrangler secret put`): JWT_SECRET, CF_ACCOUNT_ID, CF_API_TOKEN, CF_AIG_TOKEN
```

**Step 3: Verify types compile**

Run: `pnpm check`
Expected: No new errors in proxy package

---

### Task 2: Write failing tests for `/ai/chat` endpoint

**Files:**

- Modify: `packages/proxy/test/unit/proxy.test.ts`

**Step 1: Add `CF_AIG_TOKEN` to mock env factory**

In the `createEnv` function, add the new field:

```typescript
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
    CF_AIG_TOKEN: "test-aig-token",
    API: apiOverride ?? createMockApi(),
  };
}
```

**Step 2: Write the test describe block for `/ai/chat`**

Add a new `describe("AI: /ai/chat", ...)` block after the existing `/ai/toMarkdown` tests. Mock `globalThis.fetch` to intercept the outgoing AI Gateway call.

```typescript
describe("AI: /ai/chat", () => {
  let originalFetch: typeof globalThis.fetch;

  function mockGatewayFetch(response: unknown, status = 200, headers?: Record<string, string>) {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(response), {
          status,
          headers: { "content-type": "application/json", ...headers },
        }),
    ) as any;
  }

  function mockGatewayStreamFetch(chunks: string[]) {
    const body = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    ) as any;
  }

  beforeAll(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("forwards chat request to AI Gateway /compat endpoint", async () => {
    const gatewayResponse = {
      id: "chatcmpl-123",
      choices: [
        { index: 0, message: { role: "assistant", content: "Hi!" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    };
    mockGatewayFetch(gatewayResponse);

    const env = createEnv();
    const res = await worker.fetch(
      post("/ai/chat", {
        model: "openai/gpt-4o",
        inputs: { messages: [{ role: "user", content: "Hello" }] },
        providerKey: "sk-test-key",
        projectId: "proj_1",
        aiToken: aiTokens["proj_1"],
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(gatewayResponse);

    // Verify the outgoing fetch call
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://gateway.ai.cloudflare.com/v1/test-account-id/void/compat/chat/completions",
    );
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-test-key");
    expect(headers.get("cf-aig-authorization")).toBe("Bearer test-aig-token");
    expect(headers.get("cf-aig-metadata-projectid")).toBe("proj_1");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("openai/gpt-4o");
    expect(body.messages).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("requires providerKey", async () => {
    const env = createEnv();
    const res = await worker.fetch(
      post("/ai/chat", {
        model: "openai/gpt-4o",
        inputs: { messages: [{ role: "user", content: "Hello" }] },
        projectId: "proj_1",
        aiToken: aiTokens["proj_1"],
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "providerKey required" });
  });

  it("requires model", async () => {
    const env = createEnv();
    const res = await worker.fetch(
      post("/ai/chat", {
        inputs: { messages: [{ role: "user", content: "Hello" }] },
        providerKey: "sk-test",
        projectId: "proj_1",
        aiToken: aiTokens["proj_1"],
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "model required" });
  });

  it("returns streaming response when inputs.stream is true", async () => {
    mockGatewayStreamFetch([
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"!"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    const env = createEnv();
    const res = await worker.fetch(
      post("/ai/chat", {
        model: "openai/gpt-4o",
        inputs: {
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
        },
        providerKey: "sk-test-key",
        projectId: "proj_1",
        aiToken: aiTokens["proj_1"],
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");

    const text = await res.text();
    expect(text).toContain("Hi");
    expect(text).toContain("[DONE]");

    // Verify stream: true was forwarded in the body
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.stream).toBe(true);
  });

  it("forwards provider error status and message", async () => {
    mockGatewayFetch({ error: { message: "Invalid API key", type: "invalid_request_error" } }, 401);

    const env = createEnv();
    const res = await worker.fetch(
      post("/ai/chat", {
        model: "openai/gpt-4o",
        inputs: { messages: [{ role: "user", content: "Hello" }] },
        providerKey: "sk-bad-key",
        projectId: "proj_1",
        aiToken: aiTokens["proj_1"],
      }),
      env,
    );

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toContain("Invalid API key");
  });

  it("forwards extra parameters (temperature, max_tokens)", async () => {
    mockGatewayFetch({ id: "chatcmpl-1", choices: [], usage: {} });

    const env = createEnv();
    await worker.fetch(
      post("/ai/chat", {
        model: "anthropic/claude-sonnet-4-20250514",
        inputs: {
          messages: [{ role: "user", content: "Hello" }],
          temperature: 0.5,
          max_tokens: 100,
        },
        providerKey: "sk-ant-key",
        projectId: "proj_1",
        aiToken: aiTokens["proj_1"],
      }),
      env,
    );

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("anthropic/claude-sonnet-4-20250514");
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(100);
  });

  it("respects usage limit (429) for chat endpoint", async () => {
    const env = createEnv({}, { "ai-block:proj_1": "1" });
    const res = await worker.fetch(
      post("/ai/chat", {
        model: "openai/gpt-4o",
        inputs: { messages: [{ role: "user", content: "Hello" }] },
        providerKey: "sk-test",
        projectId: "proj_1",
        aiToken: aiTokens["proj_1"],
      }),
      env,
    );

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "AI usage limit exceeded" });
  });
});
```

Note: You'll also need to add `afterEach` import:

```typescript
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
```

**Step 3: Run tests to verify they fail**

Run: `pnpm test packages/proxy`
Expected: All new `/ai/chat` tests FAIL (endpoint doesn't exist yet)

---

### Task 3: Implement `/ai/chat` endpoint

**Files:**

- Modify: `packages/proxy/src/ai.ts`

**Step 1: Add the `/ai/chat` endpoint**

Add this after the existing `/ai/run` handler in `packages/proxy/src/ai.ts`:

```typescript
ai.post("/chat", async (c) => {
  const body = c.get("body");
  const projectId = c.get("projectId");

  if (!body.model) {
    return c.json({ error: "model required" }, 400);
  }
  if (!body.providerKey) {
    return c.json({ error: "providerKey required" }, 400);
  }

  const gatewayUrl = `https://gateway.ai.cloudflare.com/v1/${c.env.CF_ACCOUNT_ID}/void/compat/chat/completions`;

  // Forward inputs as OpenAI-compatible body (messages, temperature, etc.)
  const { stream, ...rest } = (body.inputs ?? {}) as Record<string, unknown>;
  const payload: Record<string, unknown> = {
    model: body.model,
    ...rest,
    ...(stream ? { stream: true } : {}),
  };

  try {
    const response = await fetch(gatewayUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${body.providerKey}`,
        "cf-aig-authorization": `Bearer ${c.env.CF_AIG_TOKEN}`,
        "cf-aig-metadata-projectId": projectId,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      let error: string;
      try {
        const json = JSON.parse(text);
        error = json.error?.message ?? text;
      } catch {
        error = text;
      }
      return c.json({ error }, response.status as 400);
    }

    if (stream && response.body) {
      return new Response(response.body, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "access-control-allow-origin": "*",
        },
      });
    }

    const result = await response.json();
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("AI Gateway error:", message);
    return c.json({ error: "gateway error" }, 502);
  }
});
```

**Step 2: Run tests to verify they pass**

Run: `pnpm test packages/proxy`
Expected: All tests pass, including new `/ai/chat` tests

**Step 3: Run lint, fmt, check**

Run: `pnpm lint && pnpm fmt && pnpm check`
Expected: No errors

---

### Task 4: Commit proxy changes

Run:

```bash
cd packages/proxy
git add src/types.ts src/ai.ts wrangler.jsonc test/unit/proxy.test.ts
```

Ask user for confirmation before committing:

```
feat: add /ai/chat proxy endpoint for third-party AI providers

Routes to CF AI Gateway's /compat/chat/completions endpoint.
User's provider API key forwarded via Authorization header.
Gateway metadata (projectId) injected for metering.
```

---

### Task 5: Add ChatCompletion types to framework

**Files:**

- Create: `framework/packages/void/src/runtime/ai-types.ts`

**Step 1: Create the types file**

```typescript
// Types for third-party AI providers via CF AI Gateway's OpenAI-compatible endpoint

export type ThirdPartyProvider =
  | "openai"
  | "anthropic"
  | "google-ai-studio"
  | "groq"
  | "mistral"
  | "grok";

export type ThirdPartyModel = `${ThirdPartyProvider}/${string}`;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionInputs {
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  stream?: boolean;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: ChatCompletionUsage;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string;
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionChunk {
  id: string;
  choices: {
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }[];
}

/** Maps provider prefix → expected env var name for the API key */
export const PROVIDER_KEY_MAP: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  "google-ai-studio": "GOOGLE_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  grok: "GROK_API_KEY",
};
```

**Step 2: Verify types compile**

Run: `pnpm check`
Expected: No errors

---

### Task 6: Update framework AI runtime for third-party providers

**Files:**

- Modify: `framework/packages/void/src/runtime/ai.ts`

This is the core change. The `run()` method in both backends needs to detect third-party models and route to the `"chat"` action.

**Step 1: Add imports and provider key resolution**

At the top of `ai.ts`, add:

```typescript
import {
  PROVIDER_KEY_MAP,
  type ThirdPartyModel,
  type ChatCompletionInputs,
  type ChatCompletionResponse,
} from "./ai-types";

function isThirdPartyModel(model: string): boolean {
  const provider = model.split("/")[0];
  return provider in PROVIDER_KEY_MAP;
}

function resolveProviderKey(model: string, runtimeEnv: RuntimeEnv): string {
  const provider = model.split("/")[0];
  const envVar = PROVIDER_KEY_MAP[provider];
  if (!envVar)
    throw new Error(
      `Unknown AI provider: "${provider}". Supported: ${Object.keys(PROVIDER_KEY_MAP).join(", ")}`,
    );
  const key = (runtimeEnv as Record<string, unknown>)[envVar];
  if (typeof key !== "string" || key.length === 0) {
    throw new Error(
      `Missing ${envVar} secret. Add it as a project secret for provider "${provider}".`,
    );
  }
  return key;
}
```

**Step 2: Update `makeServiceBindingBackend` run method**

Replace the `run` method inside `makeServiceBindingBackend`:

```typescript
    async run(model, inputs, options) {
      const projectId = runtimeEnv.__PROJECT_ID;
      const aiToken = runtimeEnv.__VOID_PROXY_TOKEN;

      // Third-party model: route to /ai/chat via AI Gateway
      if (isThirdPartyModel(model as string)) {
        const providerKey = resolveProviderKey(model as string, runtimeEnv);
        const res = await proxyFetch("chat", {
          model,
          inputs,
          providerKey,
          projectId,
          aiToken,
        });
        if ((inputs as any)?.stream) return res.body;
        return res.json();
      }

      // Workers AI: existing path via /ai/run
      const res = await proxyFetch("run", { model, inputs, options, projectId, aiToken });
      if ((inputs as any)?.stream) return res.body;
      return res.json();
    },
```

**Step 3: Update `makeHttpBackend` run method**

Replace the `run` method inside `makeHttpBackend`:

```typescript
    async run(model, inputs, options) {
      // Third-party model: route to /ai/chat via AI Gateway
      if (isThirdPartyModel(model as string)) {
        const providerKey = resolveProviderKey(model as string, runtimeEnv);
        const res = await proxyFetch("chat", {
          model,
          inputs,
          providerKey,
        });
        if ((inputs as any)?.stream) return res.json();
        return res.json();
      }

      // Workers AI: existing path via /ai/run
      const res = await proxyFetch("run", { model, inputs, options });
      if ((inputs as any)?.stream) return res.json();
      return res.json();
    },
```

Note: The HTTP backend's `proxyFetch` already appends `projectId` from closure.

**Step 4: Update `VoidAi` interface with third-party overloads**

Replace the `VoidAi` interface definition:

```typescript
export interface VoidAi extends Ai {
  /** Third-party chat completions (OpenAI, Anthropic, etc.) */
  run(
    model: ThirdPartyModel,
    inputs: ChatCompletionInputs,
    options?: AiOptions,
  ): Promise<ChatCompletionResponse>;

  /** Stream Workers AI response as SSE */
  stream<Name extends keyof AiModels>(
    model: Name,
    inputs: Omit<AiModels[Name]["inputs"], "stream">,
    options?: AiOptions,
  ): Promise<Response>;

  /** Stream third-party chat completions as SSE */
  stream(
    model: ThirdPartyModel,
    inputs: Omit<ChatCompletionInputs, "stream">,
    options?: AiOptions,
  ): Promise<Response>;
}
```

**Step 5: Re-export types from the ai module**

At the bottom of `ai.ts`, add re-exports so users can import types:

```typescript
export type {
  ThirdPartyModel,
  ThirdPartyProvider,
  ChatCompletionInputs,
  ChatCompletionResponse,
  ChatCompletionChoice,
  ChatCompletionUsage,
  ChatCompletionChunk,
  ChatMessage,
} from "./ai-types";
```

**Step 6: Verify types compile**

Run: `pnpm check`
Expected: No errors

---

### Task 7: Commit framework changes

Run:

```bash
cd framework
git add packages/void/src/runtime/ai.ts packages/void/src/runtime/ai-types.ts
```

Ask user for confirmation before committing:

```
feat: support third-party AI providers via BYOK

Add provider detection, API key resolution from env, and "chat" action
that routes to the proxy's /ai/chat endpoint. Users can now call
ai.run("openai/gpt-4o", { messages: [...] }) with their own API key
stored as a project secret.
```

Then update the submodule pointer in the platform repo:

```bash
cd ..
git add framework
```

---

### Task 8: Full verification

**Step 1: Build all packages**

Run: `pnpm -r build`
Expected: All packages build successfully

**Step 2: Run proxy tests**

Run: `pnpm test packages/proxy`
Expected: All tests pass

**Step 3: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

**Step 4: Lint, format, typecheck**

Run: `pnpm lint && pnpm fmt && pnpm check`
Expected: No errors or warnings

---

### Task 9: Update design doc status

**Files:**

- Modify: `meta/design-docs/0049-multi-provider-ai.md`

Change `**Status:** Draft` to `**Status:** Implemented`

---

### Operational Notes (post-merge)

These are manual steps for after the code is merged and ready to deploy:

1. **Create CF AI Gateway token** — In the Cloudflare dashboard, create an API token with AI Gateway read/write permissions. This becomes `CF_AIG_TOKEN`.

2. **Set the secret** on both production and staging:

   ```bash
   cd packages/proxy
   wrangler secret put CF_AIG_TOKEN
   wrangler secret put CF_AIG_TOKEN --env staging
   ```

3. **Verify the `void` gateway** supports the `/compat` endpoint — it should already since it's a standard AI Gateway feature.

4. **Test with a real provider key** — deploy to staging, set an OpenAI API key as a project secret, and test `ai.run("openai/gpt-4o", { messages: [...] })`.
