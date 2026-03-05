import { Hono } from "hono";
import type { ProxyEnv } from "./types";
import { resolveResource } from "./resolve";
import { dispatchToWorker } from "./dispatch";

const CF_API = "https://api.cloudflare.com/client/v4";

const d1 = new Hono<ProxyEnv>();

d1.post("/query", async (c) => {
  const body = c.get("body");
  const projectId = c.get("projectId");

  if (!body.binding || !body.sql) {
    return c.json({ error: "binding and sql required" }, 400);
  }

  // Try WfP dispatch first (native bindings, ~1-5ms)
  const dispatchRes = await dispatchToWorker(c.env, projectId, "/d1/query", body);
  if (dispatchRes) return dispatchRes;

  // Fallback: CF REST API (for old deploys without /__void handler)
  let dbId: string;
  try {
    dbId = await resolveResource(c.env.API, c.env.JWT_SECRET, projectId, "d1", body.binding);
  } catch {
    return c.json({ error: `unknown binding "${body.binding}"` }, 404);
  }

  const cfRes = await fetch(`${CF_API}/accounts/${c.env.CF_ACCOUNT_ID}/d1/database/${dbId}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql: body.sql, params: body.params ?? [] }),
  });

  if (!cfRes.ok) {
    return c.json({ error: "D1 query failed", status: cfRes.status }, 502);
  }

  const cfData = (await cfRes.json()) as {
    result?: { results?: Record<string, unknown>[]; meta?: Record<string, unknown> }[];
  };
  const qr = cfData.result?.[0];

  if (!qr) {
    return c.json({ error: "unexpected D1 response" }, 502);
  }

  switch (body.method) {
    case "first":
      return c.json(qr.results?.[0] ?? null);
    case "raw": {
      const columns = qr.results?.length ? Object.keys(qr.results[0]) : [];
      const values = (qr.results ?? []).map((r) => Object.values(r));
      return c.json({ columns, results: values, meta: qr.meta });
    }
    case "run":
      return c.json({ success: true, meta: qr.meta });
    case "all":
    default:
      return c.json({ results: qr.results ?? [], success: true, meta: qr.meta });
  }
});

d1.post("/batch", async (c) => {
  const body = c.get("body");
  const projectId = c.get("projectId");

  if (!body.binding || !Array.isArray(body.statements)) {
    return c.json({ error: "binding and statements required" }, 400);
  }

  // Try WfP dispatch first (native db.batch() with transactional guarantees)
  const dispatchRes = await dispatchToWorker(c.env, projectId, "/d1/batch", body);
  if (dispatchRes) return dispatchRes;

  // Fallback: CF REST API (sequential, no transaction)
  let dbId: string;
  try {
    dbId = await resolveResource(c.env.API, c.env.JWT_SECRET, projectId, "d1", body.binding);
  } catch {
    return c.json({ error: `unknown binding "${body.binding}"` }, 404);
  }

  const results = [];
  for (const stmt of body.statements as { sql: string; params?: unknown[] }[]) {
    const cfRes = await fetch(
      `${CF_API}/accounts/${c.env.CF_ACCOUNT_ID}/d1/database/${dbId}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.env.CF_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sql: stmt.sql, params: stmt.params ?? [] }),
      },
    );

    if (!cfRes.ok) {
      return c.json({ error: "D1 batch query failed", status: cfRes.status }, 502);
    }

    const cfData = (await cfRes.json()) as {
      result?: { results?: unknown[]; meta?: Record<string, unknown> }[];
    };
    const qr = cfData.result?.[0];
    results.push({ results: qr?.results ?? [], success: true, meta: qr?.meta });
  }

  return c.json(results);
});

export { d1 };
