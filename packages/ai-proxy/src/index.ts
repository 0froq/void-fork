interface Env {
  AI: Ai;
  JWT_SECRET: string;
  ROUTING: KVNamespace;
}

interface ProxyRequest {
  action: "run" | "models" | "toMarkdown";
  model?: string;
  inputs?: unknown;
  options?: Record<string, unknown>;
  projectId?: string;
  aiToken?: string;
}

interface JwtPayload {
  sub: string;
  login: string;
  iat: number;
  exp: number;
}

const GATEWAY_ID = "void";
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Cache CryptoKey per isolate — importKey is expensive and secret never changes
let cachedVerifyKey: CryptoKey | undefined;
let cachedKeySecret: string | undefined;

async function getVerifyKey(secret: string): Promise<CryptoKey> {
  if (cachedVerifyKey && cachedKeySecret === secret) return cachedVerifyKey;
  cachedVerifyKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  cachedKeySecret = secret;
  return cachedVerifyKey;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Health check
    if (req.method === "GET" && req.url.endsWith("/health")) {
      return Response.json({
        ok: true,
        bindings: {
          ai: !!env.AI,
          kv: !!env.ROUTING,
          jwt: !!env.JWT_SECRET,
        },
      });
    }

    if (req.method !== "POST") {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }

    // Parse body once
    let body: ProxyRequest;
    try {
      body = (await req.json()) as ProxyRequest;
    } catch {
      return Response.json({ error: "invalid JSON body" }, { status: 400, headers: CORS_HEADERS });
    }

    // Determine authentication context
    let projectId: string;

    const authHeader = req.headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      // HTTPS path (local dev) — validate JWT
      const token = authHeader.slice(7);
      const payload = await verifyJwt(token, env.JWT_SECRET);
      if (!payload) {
        return Response.json({ error: "invalid or expired token" }, { status: 401 });
      }

      if (!body.projectId) {
        return Response.json({ error: "projectId required" }, { status: 400 });
      }
      projectId = body.projectId;
    } else {
      // Service binding path (production) — verify HMAC-signed project token
      if (!body.projectId || !body.aiToken) {
        return Response.json({ error: "projectId and aiToken required" }, { status: 400 });
      }
      if (!(await verifyHmac(body.projectId, body.aiToken, env.JWT_SECRET))) {
        return Response.json({ error: "invalid project token" }, { status: 403 });
      }
      projectId = body.projectId;
    }

    if (await env.ROUTING.get(`ai-block:${projectId}`, { cacheTtl: 60 })) {
      return Response.json(
        { error: "AI usage limit exceeded" },
        { status: 429, headers: CORS_HEADERS },
      );
    }

    return handleAction(env, body, projectId);
  },
};

async function handleAction(env: Env, body: ProxyRequest, projectId: string): Promise<Response> {
  try {
    switch (body.action) {
      case "run": {
        if (!body.model) {
          return Response.json({ error: "model required" }, { status: 400 });
        }
        const options = {
          ...(body.options ?? {}),
          gateway: { id: GATEWAY_ID, metadata: { projectId } },
        };
        const result = await (env.AI as any).run(body.model, body.inputs, options);

        if (result instanceof ReadableStream) {
          return new Response(result, {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              ...CORS_HEADERS,
            },
          });
        }
        return Response.json(result, { headers: CORS_HEADERS });
      }

      case "models": {
        const result = await (env.AI as any).models(body.inputs);
        return Response.json(result, { headers: CORS_HEADERS });
      }

      case "toMarkdown": {
        const result = await (env.AI as any).toMarkdown(body.inputs, body.options);
        return Response.json(result, { headers: CORS_HEADERS });
      }

      default:
        return Response.json({ error: "unknown action" }, { status: 400, headers: CORS_HEADERS });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("AI inference error:", message);
    return Response.json({ error: "inference error" }, { status: 502, headers: CORS_HEADERS });
  }
}

// --- HMAC verification for project tokens ---

async function verifyHmac(data: string, signature: string, secret: string): Promise<boolean> {
  try {
    const key = await getVerifyKey(secret);
    const sigBytes = base64urlDecode(signature);
    return crypto.subtle.verify("HMAC", key, sigBytes.buffer as ArrayBuffer, encoder.encode(data));
  } catch {
    return false;
  }
}

// --- JWT verification (same algorithm as platform) ---

function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, body, signature] = parts;

  try {
    const key = await getVerifyKey(secret);
    const sigBytes = base64urlDecode(signature);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes.buffer as ArrayBuffer,
      encoder.encode(`${header}.${body}`),
    );
    if (!valid) return null;

    const payload = JSON.parse(decoder.decode(base64urlDecode(body))) as JwtPayload;

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) return null;

    return payload;
  } catch {
    return null;
  }
}
