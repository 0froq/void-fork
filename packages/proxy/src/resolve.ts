/**
 * Resolves a project's binding to its Cloudflare resource ID via the API service binding.
 */
export async function resolveResource(
  api: Fetcher,
  jwtSecret: string,
  projectId: string,
  type: "d1" | "kv" | "r2",
  bindingName: string,
): Promise<string> {
  const token = await hmacSign(projectId, jwtSecret);
  const res = await api.fetch(`https://api/internal/resolve-resource/${projectId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-void-internal": token,
    },
    body: JSON.stringify({ type, binding: bindingName }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Resource resolution failed (${res.status}): ${text}`);
  }

  const data = await res.json<{ cf_id: string }>();
  return data.cf_id;
}

// --- HMAC signing (mirrors packages/api/src/auth/hmac.ts) ---

const encoder = new TextEncoder();
let cachedSignKey: CryptoKey | undefined;
let cachedKeySecret: string | undefined;

async function getSignKey(secret: string): Promise<CryptoKey> {
  if (cachedSignKey && cachedKeySecret === secret) return cachedSignKey;
  cachedSignKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  cachedKeySecret = secret;
  return cachedSignKey;
}

async function hmacSign(data: string, secret: string): Promise<string> {
  const key = await getSignKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  const binary = String.fromCharCode(...new Uint8Array(sig));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
