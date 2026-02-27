const encoder = new TextEncoder();

// Cache CryptoKeys per secret — importKey is expensive and the secret never changes per isolate
const signKeyCache = new Map<string, CryptoKey>();
const verifyKeyCache = new Map<string, CryptoKey>();

async function getSignKey(secret: string): Promise<CryptoKey> {
  let key = signKeyCache.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    signKeyCache.set(secret, key);
  }
  return key;
}

async function getVerifyKey(secret: string): Promise<CryptoKey> {
  let key = verifyKeyCache.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    verifyKeyCache.set(secret, key);
  }
  return key;
}

export async function hmacSignState(data: string, secret: string): Promise<string> {
  const key = await getSignKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  const binary = String.fromCharCode(...new Uint8Array(sig));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hmacVerifyState(
  data: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const key = await getVerifyKey(secret);
  const padded = signature.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const sigBytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(data));
}
