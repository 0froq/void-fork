import { Hono } from "hono";
import type { PlatformEnv } from "../env";
import { getProject } from "../db";

const DEFAULT_DISPATCH_NAMESPACE = "vite-cloud-users";

const app = new Hono<PlatformEnv>();

function isValidSecretName(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name);
}

app.get("/:id/secrets", async (c) => {
  const projectId = c.req.param("id");
  const project = await getProject(c.get("db"), projectId);
  if (!project) {
    return c.json({ error: "project not found" }, 404);
  }
  if (project.user_id !== c.get("userId")) {
    return c.json({ error: "forbidden" }, 403);
  }

  // Dev bypass — skip CF API call for secrets listing
  if (c.env.DEV_AUTH_BYPASS) {
    return c.json([]);
  }

  const dispatchNamespace = c.env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
  const workerName = `user-${project.slug}`;
  const cfRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${workerName}/secrets`,
    {
      headers: {
        Authorization: `Bearer ${c.env.CF_API_TOKEN}`,
      },
    },
  );

  if (!cfRes.ok) {
    if (cfRes.status === 404) {
      return c.json([]);
    }
    const details = await cfRes.text();
    return c.json({ error: "failed to list secrets", details }, 502);
  }

  const result = await cfRes.json<{ result: { name: string; type: string }[] }>();
  return c.json(result.result.map((s) => ({ name: s.name })));
});

app.put("/:id/secrets/:name", async (c) => {
  const projectId = c.req.param("id");
  const secretName = c.req.param("name");
  if (!isValidSecretName(secretName)) {
    return c.json({ error: "invalid secret name" }, 400);
  }

  const project = await getProject(c.get("db"), projectId);
  if (!project) {
    return c.json({ error: "project not found" }, 404);
  }
  if (project.user_id !== c.get("userId")) {
    return c.json({ error: "forbidden" }, 403);
  }

  let body: { value?: string } = {};
  try {
    body = await c.req.json<{ value?: string }>();
  } catch {
    body = {};
  }
  if (typeof body.value !== "string" || body.value.length === 0) {
    return c.json({ error: "value is required" }, 400);
  }

  const dispatchNamespace = c.env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
  const workerName = `user-${project.slug}`;
  const cfRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${workerName}/secrets`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${c.env.CF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: secretName,
        text: body.value,
        type: "secret_text",
      }),
    },
  );

  if (!cfRes.ok) {
    const details = await cfRes.text();
    return c.json({ error: "secret update failed", details }, 502);
  }

  return c.json({ ok: true, name: secretName });
});

app.delete("/:id/secrets/:name", async (c) => {
  const projectId = c.req.param("id");
  const secretName = c.req.param("name");
  if (!isValidSecretName(secretName)) {
    return c.json({ error: "invalid secret name" }, 400);
  }

  const project = await getProject(c.get("db"), projectId);
  if (!project) {
    return c.json({ error: "project not found" }, 404);
  }
  if (project.user_id !== c.get("userId")) {
    return c.json({ error: "forbidden" }, 403);
  }

  const dispatchNamespace = c.env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
  const workerName = `user-${project.slug}`;
  const cfRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${workerName}/secrets/${encodeURIComponent(secretName)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${c.env.CF_API_TOKEN}`,
      },
    },
  );

  if (!cfRes.ok) {
    const details = await cfRes.text();
    return c.json({ error: "secret delete failed", details }, 502);
  }

  return c.json({ ok: true, name: secretName });
});

export default app;
