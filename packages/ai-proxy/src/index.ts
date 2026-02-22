interface Env {
  AI: Ai;
  JWT_SECRET: string;
}

interface ProxyRequest {
  action: "run" | "models" | "toMarkdown";
  model?: string;
  inputs?: unknown;
  options?: Record<string, unknown>;
  projectId?: string;
}

interface JwtPayload {
  sub: string;
  login: string;
  iat: number;
  exp: number;
}

const GATEWAY_ID = "vite-cloud";
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (req.method !== "POST") {
      return Response.json({ error: "method not allowed" }, { status: 405 });
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

      const body = (await req.json()) as ProxyRequest;
      if (!body.projectId) {
        return Response.json({ error: "projectId required" }, { status: 400 });
      }
      projectId = body.projectId;

      return handleAction(env, body, projectId);
    }

    // Service binding path (production) — trusted, projectId from body
    const body = (await req.json()) as ProxyRequest;
    if (!body.projectId) {
      return Response.json({ error: "projectId required" }, { status: 400 });
    }
    projectId = body.projectId;

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

        if ((body.inputs as any)?.stream) {
          return new Response(result as ReadableStream, {
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
    return Response.json({ error: message }, { status: 502, headers: CORS_HEADERS });
  }
}

// --- JWT verification (same algorithm as platform) ---

function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, body, signature] = parts;

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const sigBytes = base64urlDecode(signature);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes.buffer as ArrayBuffer,
      encoder.encode(`${header}.${body}`),
    );
    if (!valid) return null;

    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(body))) as JwtPayload;

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) return null;

    return payload;
  } catch {
    return null;
  }
}
