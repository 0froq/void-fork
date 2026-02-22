import { env } from "cloudflare:workers";

const PROXY_URL = "https://ai-proxy.vite.cloud";
const STAGING_PROXY_URL = "https://ai-proxy.staging.vite.cloud";

interface AiBackend {
  run(model: string, inputs: unknown, options?: unknown): Promise<unknown>;
  models(params?: unknown): Promise<unknown>;
  toMarkdown(items: unknown, options?: unknown): Promise<unknown>;
}

function getProxyUrl(): string {
  const custom = (env as any).__AI_PROXY_URL;
  if (custom) return custom;
  return (env as any).__VITE_CLOUD_STAGING ? STAGING_PROXY_URL : PROXY_URL;
}

function resolveBackend(): AiBackend {
  // Priority 1: Service binding (production via Vite Cloud)
  const proxy = (env as any).__AI_PROXY;
  if (proxy) return makeServiceBindingBackend(proxy);

  // Priority 2: HTTPS to our proxy (local dev with Vite Cloud auth)
  const token = (env as any).__VITE_CLOUD_TOKEN;
  const projectId = (env as any).__VITE_CLOUD_PROJECT_ID;
  if (token && projectId) return makeHttpBackend(token, projectId);

  // Priority 3: Direct AI binding (user's own CF account)
  const directAi = (env as any).AI;
  if (directAi) {
    return {
      run: directAi.run.bind(directAi),
      models: directAi.models.bind(directAi),
      toMarkdown: directAi.toMarkdown?.bind(directAi) ?? unsupported("toMarkdown"),
    };
  }

  throw new Error("AI not available. Run `vcc login` and `vcc link` to get started.");
}

function unsupported(method: string): () => never {
  return () => {
    throw new Error(`ai.${method}() is not supported in this environment`);
  };
}

function makeServiceBindingBackend(proxy: Fetcher): AiBackend {
  async function proxyFetch(action: string, body: Record<string, unknown>): Promise<Response> {
    const res = await proxy.fetch(`https://ai-proxy/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...body }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`AI proxy error: ${res.status} ${text}`);
    }
    return res;
  }

  return {
    async run(model, inputs, options) {
      const projectId = (env as any).__PROJECT_ID;
      const res = await proxyFetch("run", { model, inputs, options, projectId });
      if ((inputs as any)?.stream) return res.body;
      return res.json();
    },
    async models(params) {
      const projectId = (env as any).__PROJECT_ID;
      const res = await proxyFetch("models", { inputs: params, projectId });
      return res.json();
    },
    async toMarkdown(items, options) {
      const projectId = (env as any).__PROJECT_ID;
      const res = await proxyFetch("toMarkdown", { inputs: items, options, projectId });
      return res.json();
    },
  };
}

function makeHttpBackend(token: string, projectId: string): AiBackend {
  const base = getProxyUrl();
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };

  async function proxyFetch(action: string, body: Record<string, unknown>): Promise<Response> {
    const res = await fetch(`${base}/${action}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action, ...body, projectId }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`AI proxy error: ${res.status} ${text}`);
    }
    return res;
  }

  return {
    async run(model, inputs, options) {
      const res = await proxyFetch("run", { model, inputs, options });
      if ((inputs as any)?.stream) return res.body;
      return res.json();
    },
    async models(params) {
      const res = await proxyFetch("models", { inputs: params });
      return res.json();
    },
    async toMarkdown(items, options) {
      const res = await proxyFetch("toMarkdown", { inputs: items, options });
      return res.json();
    },
  };
}

// Lazy-init backend on first access
let _backend: AiBackend | undefined;
function backend(): AiBackend {
  return (_backend ??= resolveBackend());
}

/**
 * Extended AI interface with a convenience `stream()` method.
 *
 * `stream()` calls `ai.run()` with `stream: true` and wraps the result
 * in a `Response` with SSE headers — ready to return from a route handler.
 */
export interface ViteCloudAi extends Ai {
  stream<Name extends keyof AiModels>(
    model: Name,
    inputs: Omit<AiModels[Name]["inputs"], "stream">,
    options?: AiOptions,
  ): Promise<Response>;
}

export const ai: ViteCloudAi = new Proxy({} as ViteCloudAi, {
  get(_, prop) {
    if (prop === "stream") {
      return async (model: string, inputs: Record<string, unknown>, options?: unknown) => {
        const body = await backend().run(model, { ...inputs, stream: true }, options);
        return new Response(body as ReadableStream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      };
    }
    if (prop === "run") return backend().run;
    if (prop === "models") return backend().models;
    if (prop === "toMarkdown") return backend().toMarkdown;
    return undefined;
  },
});
