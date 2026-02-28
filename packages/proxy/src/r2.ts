import { Hono } from "hono";
import type { ProxyEnv } from "./types";
import { resolveResource } from "./resolve";

const CF_API = "https://api.cloudflare.com/client/v4";

const r2 = new Hono<ProxyEnv>();

function cfHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

r2.post("/get", async (c) => {
  const body = c.get("body");
  const projectId = c.get("projectId");

  if (!body.binding || !body.key) {
    return c.json({ error: "binding and key required" }, 400);
  }

  let bucket: string;
  try {
    bucket = await resolveResource(c.env.DB, projectId, "r2", body.binding);
  } catch {
    return c.json({ error: `unknown binding "${body.binding}"` }, 404);
  }

  const cfRes = await fetch(
    `${CF_API}/accounts/${c.env.CF_ACCOUNT_ID}/r2/buckets/${bucket}/objects/${encodeURIComponent(body.key as string)}`,
    { headers: cfHeaders(c.env.CF_API_TOKEN) },
  );

  if (cfRes.status === 404) {
    return c.json(null);
  }

  if (!cfRes.ok) {
    return c.json({ error: "R2 get failed", status: cfRes.status }, 502);
  }

  // Stream the object body back, preserve metadata in headers
  const headers = new Headers();
  headers.set("content-type", cfRes.headers.get("content-type") ?? "application/octet-stream");
  if (cfRes.headers.has("content-length")) {
    headers.set("content-length", cfRes.headers.get("content-length")!);
  }
  if (cfRes.headers.has("etag")) {
    headers.set("etag", cfRes.headers.get("etag")!);
  }
  if (cfRes.headers.has("last-modified")) {
    headers.set("last-modified", cfRes.headers.get("last-modified")!);
  }

  return new Response(cfRes.body, { headers });
});

r2.post("/put", async (c) => {
  const body = c.get("body");
  const projectId = c.get("projectId");

  if (!body.binding || !body.key) {
    return c.json({ error: "binding and key required" }, 400);
  }

  let bucket: string;
  try {
    bucket = await resolveResource(c.env.DB, projectId, "r2", body.binding);
  } catch {
    return c.json({ error: `unknown binding "${body.binding}"` }, 404);
  }

  // Decode base64 value from JSON body, or use text value
  const data = body.base64
    ? Uint8Array.from(atob(body.base64 as string), (ch) => ch.charCodeAt(0))
    : new TextEncoder().encode((body.value as string) ?? "");

  const cfRes = await fetch(
    `${CF_API}/accounts/${c.env.CF_ACCOUNT_ID}/r2/buckets/${bucket}/objects/${encodeURIComponent(body.key as string)}`,
    {
      method: "PUT",
      headers: {
        ...cfHeaders(c.env.CF_API_TOKEN),
        "Content-Type": (body.contentType as string) ?? "application/octet-stream",
      },
      body: data,
    },
  );

  if (!cfRes.ok) {
    return c.json({ error: "R2 put failed", status: cfRes.status }, 502);
  }

  return c.json({ success: true });
});

r2.post("/delete", async (c) => {
  const body = c.get("body");
  const projectId = c.get("projectId");

  if (!body.binding) {
    return c.json({ error: "binding required" }, 400);
  }

  const keys: string[] = body.keys ? (body.keys as string[]) : body.key ? [body.key as string] : [];

  if (keys.length === 0) {
    return c.json({ error: "key or keys required" }, 400);
  }

  let bucket: string;
  try {
    bucket = await resolveResource(c.env.DB, projectId, "r2", body.binding);
  } catch {
    return c.json({ error: `unknown binding "${body.binding}"` }, 404);
  }

  for (const key of keys) {
    const cfRes = await fetch(
      `${CF_API}/accounts/${c.env.CF_ACCOUNT_ID}/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`,
      {
        method: "DELETE",
        headers: cfHeaders(c.env.CF_API_TOKEN),
      },
    );
    if (!cfRes.ok && cfRes.status !== 404) {
      return c.json({ error: "R2 delete failed", status: cfRes.status }, 502);
    }
  }

  return c.json({ success: true });
});

r2.post("/list", async (c) => {
  const body = c.get("body");
  const projectId = c.get("projectId");

  if (!body.binding) {
    return c.json({ error: "binding required" }, 400);
  }

  let bucket: string;
  try {
    bucket = await resolveResource(c.env.DB, projectId, "r2", body.binding);
  } catch {
    return c.json({ error: `unknown binding "${body.binding}"` }, 404);
  }

  const params = new URLSearchParams();
  if (body.prefix) params.set("prefix", body.prefix as string);
  if (body.limit) params.set("per_page", String(body.limit));
  if (body.cursor) params.set("cursor", body.cursor as string);
  if (body.delimiter) params.set("delimiter", body.delimiter as string);
  const qs = params.toString() ? `?${params.toString()}` : "";

  const cfRes = await fetch(
    `${CF_API}/accounts/${c.env.CF_ACCOUNT_ID}/r2/buckets/${bucket}/objects${qs}`,
    { headers: cfHeaders(c.env.CF_API_TOKEN) },
  );

  if (!cfRes.ok) {
    return c.json({ error: "R2 list failed", status: cfRes.status }, 502);
  }

  const data = (await cfRes.json()) as {
    result?: { key: string; size: number; last_modified?: string }[];
    result_info?: { cursor?: string };
  };

  return c.json({
    objects: (data.result ?? []).map((o) => ({
      key: o.key,
      size: o.size,
      lastModified: o.last_modified ?? "",
    })),
    truncated: !!data.result_info?.cursor,
    cursor: data.result_info?.cursor ?? null,
  });
});

r2.post("/head", async (c) => {
  const body = c.get("body");
  const projectId = c.get("projectId");

  if (!body.binding || !body.key) {
    return c.json({ error: "binding and key required" }, 400);
  }

  let bucket: string;
  try {
    bucket = await resolveResource(c.env.DB, projectId, "r2", body.binding);
  } catch {
    return c.json({ error: `unknown binding "${body.binding}"` }, 404);
  }

  const cfRes = await fetch(
    `${CF_API}/accounts/${c.env.CF_ACCOUNT_ID}/r2/buckets/${bucket}/objects/${encodeURIComponent(body.key as string)}`,
    {
      method: "HEAD",
      headers: cfHeaders(c.env.CF_API_TOKEN),
    },
  );

  if (cfRes.status === 404) {
    return c.json(null);
  }

  if (!cfRes.ok) {
    return c.json({ error: "R2 head failed", status: cfRes.status }, 502);
  }

  return c.json({
    key: body.key,
    size: parseInt(cfRes.headers.get("content-length") ?? "0"),
    etag: cfRes.headers.get("etag") ?? "",
    lastModified: cfRes.headers.get("last-modified") ?? "",
    contentType: cfRes.headers.get("content-type") ?? "application/octet-stream",
  });
});

export { r2 };
