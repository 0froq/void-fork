import { Hono } from "hono";
import type { ProxyEnv } from "./types";
import { resolveResource } from "./resolve";

const CF_API = "https://api.cloudflare.com/client/v4";

const kv = new Hono<ProxyEnv>();

kv.post("/get", async (c) => {
  const body = c.get("body");
  const projectId = c.get("projectId");

  if (!body.binding || !body.key) {
    return c.json({ error: "binding and key required" }, 400);
  }

  let nsId: string;
  try {
    nsId = await resolveResource(c.env.DB, projectId, "kv", body.binding);
  } catch {
    return c.json({ error: `unknown binding "${body.binding}"` }, 404);
  }

  const cfRes = await fetch(
    `${CF_API}/accounts/${c.env.CF_ACCOUNT_ID}/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(body.key)}`,
    { headers: { Authorization: `Bearer ${c.env.CF_API_TOKEN}` } },
  );

  if (cfRes.status === 404) {
    return c.json(null);
  }

  if (!cfRes.ok) {
    return c.json({ error: "KV get failed", status: cfRes.status }, 502);
  }

  const type = (body.type as string) ?? "text";
  if (type === "json") {
    return c.json(await cfRes.json());
  }
  if (type === "arrayBuffer") {
    return new Response(await cfRes.arrayBuffer(), {
      headers: { "content-type": "application/octet-stream" },
    });
  }
  if (type === "stream") {
    return new Response(cfRes.body, {
      headers: { "content-type": "application/octet-stream" },
    });
  }
  // Default: text
  return c.json(await cfRes.text());
});

kv.post("/put", async (c) => {
  const body = c.get("body");
  const projectId = c.get("projectId");

  if (!body.binding || !body.key) {
    return c.json({ error: "binding and key required" }, 400);
  }

  let nsId: string;
  try {
    nsId = await resolveResource(c.env.DB, projectId, "kv", body.binding);
  } catch {
    return c.json({ error: `unknown binding "${body.binding}"` }, 404);
  }

  const params = new URLSearchParams();
  if (body.expiration) params.set("expiration", String(body.expiration));
  if (body.expiration_ttl) params.set("expiration_ttl", String(body.expiration_ttl));
  const qs = params.toString() ? `?${params.toString()}` : "";

  let value: string | ArrayBuffer;
  let contentType = "text/plain";
  if (body.base64 && typeof body.value === "string") {
    // Decode base64-encoded binary data from the client
    const binary = atob(body.value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    value = bytes.buffer;
    contentType = "application/octet-stream";
  } else {
    value = typeof body.value === "string" ? body.value : JSON.stringify(body.value);
  }

  const cfRes = await fetch(
    `${CF_API}/accounts/${c.env.CF_ACCOUNT_ID}/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(body.key)}${qs}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${c.env.CF_API_TOKEN}`,
        "Content-Type": contentType,
      },
      body: value,
    },
  );

  if (!cfRes.ok) {
    return c.json({ error: "KV put failed", status: cfRes.status }, 502);
  }

  return c.json({ success: true });
});

kv.post("/delete", async (c) => {
  const body = c.get("body");
  const projectId = c.get("projectId");

  if (!body.binding || !body.key) {
    return c.json({ error: "binding and key required" }, 400);
  }

  let nsId: string;
  try {
    nsId = await resolveResource(c.env.DB, projectId, "kv", body.binding);
  } catch {
    return c.json({ error: `unknown binding "${body.binding}"` }, 404);
  }

  const cfRes = await fetch(
    `${CF_API}/accounts/${c.env.CF_ACCOUNT_ID}/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(body.key)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${c.env.CF_API_TOKEN}` },
    },
  );

  // 404 is fine — delete is idempotent
  if (!cfRes.ok && cfRes.status !== 404) {
    return c.json({ error: "KV delete failed", status: cfRes.status }, 502);
  }

  return c.json({ success: true });
});

kv.post("/list", async (c) => {
  const body = c.get("body");
  const projectId = c.get("projectId");

  if (!body.binding) {
    return c.json({ error: "binding required" }, 400);
  }

  let nsId: string;
  try {
    nsId = await resolveResource(c.env.DB, projectId, "kv", body.binding);
  } catch {
    return c.json({ error: `unknown binding "${body.binding}"` }, 404);
  }

  const params = new URLSearchParams();
  if (body.prefix) params.set("prefix", body.prefix as string);
  if (body.limit) params.set("limit", String(body.limit));
  if (body.cursor) params.set("cursor", body.cursor as string);
  const qs = params.toString() ? `?${params.toString()}` : "";

  const cfRes = await fetch(
    `${CF_API}/accounts/${c.env.CF_ACCOUNT_ID}/storage/kv/namespaces/${nsId}/keys${qs}`,
    { headers: { Authorization: `Bearer ${c.env.CF_API_TOKEN}` } },
  );

  if (!cfRes.ok) {
    return c.json({ error: "KV list failed", status: cfRes.status }, 502);
  }

  const data = (await cfRes.json()) as {
    result?: { name: string }[];
    result_info?: { cursor?: string };
  };
  return c.json({
    keys: data.result ?? [],
    list_complete: !data.result_info?.cursor,
    cursor: data.result_info?.cursor ?? null,
  });
});

export { kv };
