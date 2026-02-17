import { Hono } from "hono";
import type { PlatformEnv } from "../env";
import {
  getProject,
  createDomain,
  getDomainsByProjectId,
  getDomain,
  getDomainByHostname,
  updateDomainStatus,
  deleteDomain,
} from "../db";
import {
  createCustomHostname,
  getCustomHostname,
  deleteCustomHostname,
} from "../provisioning/cloudflare-api";

const CNAME_TARGET = "cname.vitecloud.app";

const app = new Hono<PlatformEnv>();

// Add a custom domain to a project
app.post("/:id/domains", async (c) => {
  const projectId = c.req.param("id");
  const project = await getProject(c.env.DB, projectId);
  if (!project) {
    return c.json({ error: "project not found" }, 404);
  }

  if (project.user_id !== c.get("userId")) {
    return c.json({ error: "forbidden" }, 403);
  }

  const { hostname } = await c.req.json<{ hostname: string }>();

  // Validate hostname format
  if (!hostname || typeof hostname !== "string") {
    return c.json({ error: "hostname is required" }, 400);
  }

  // Must be a valid domain (basic check)
  if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(hostname)) {
    return c.json({ error: "invalid hostname format" }, 400);
  }

  // Cannot be a vitecloud.app subdomain
  if (hostname.endsWith(".vitecloud.app")) {
    return c.json({ error: "cannot use vitecloud.app subdomains" }, 400);
  }

  // Uniqueness check
  const existing = await getDomainByHostname(c.env.DB, hostname);
  if (existing) {
    return c.json({ error: "hostname already in use" }, 409);
  }

  // Create custom hostname via CF API
  const cfHostname = await createCustomHostname(c.env.CF_ZONE_ID, c.env.CF_API_TOKEN, hostname);

  // Insert domain record
  const domain = await createDomain(c.env.DB, projectId, hostname, cfHostname.id);

  return c.json({
    ...domain,
    cname_target: CNAME_TARGET,
  });
});

// List domains for a project
app.get("/:id/domains", async (c) => {
  const projectId = c.req.param("id");
  const project = await getProject(c.env.DB, projectId);
  if (!project) {
    return c.json({ error: "project not found" }, 404);
  }

  if (project.user_id !== c.get("userId")) {
    return c.json({ error: "forbidden" }, 403);
  }

  const domains = await getDomainsByProjectId(c.env.DB, projectId);
  return c.json(domains);
});

// Get domain status (polls CF API for live status)
app.get("/:id/domains/:domainId", async (c) => {
  const projectId = c.req.param("id");
  const domainId = c.req.param("domainId");

  const project = await getProject(c.env.DB, projectId);
  if (!project) {
    return c.json({ error: "project not found" }, 404);
  }

  if (project.user_id !== c.get("userId")) {
    return c.json({ error: "forbidden" }, 403);
  }

  const domain = await getDomain(c.env.DB, domainId);
  if (!domain || domain.project_id !== projectId) {
    return c.json({ error: "domain not found" }, 404);
  }

  // Poll CF API for live status
  const cfHostname = await getCustomHostname(
    c.env.CF_ZONE_ID,
    c.env.CF_API_TOKEN,
    domain.cf_hostname_id,
  );

  // If CF says active and DB says pending, update DB + write KV routing entry
  if (cfHostname.status === "active" && domain.status === "pending") {
    await updateDomainStatus(c.env.DB, domain.id, "active");

    // Write KV routing entry for this domain
    const slugRouting = await c.env.ROUTING.get(project.slug);
    if (slugRouting) {
      await c.env.ROUTING.put(`domain:${domain.hostname}`, slugRouting);
    }
  }

  return c.json({
    ...domain,
    status: cfHostname.status === "active" ? "active" : domain.status,
    ssl_status: cfHostname.ssl.status,
    verification_errors: cfHostname.verification_errors,
  });
});

// Remove a custom domain
app.delete("/:id/domains/:domainId", async (c) => {
  const projectId = c.req.param("id");
  const domainId = c.req.param("domainId");

  const project = await getProject(c.env.DB, projectId);
  if (!project) {
    return c.json({ error: "project not found" }, 404);
  }

  if (project.user_id !== c.get("userId")) {
    return c.json({ error: "forbidden" }, 403);
  }

  const domain = await getDomain(c.env.DB, domainId);
  if (!domain || domain.project_id !== projectId) {
    return c.json({ error: "domain not found" }, 404);
  }

  // Delete from CF
  await deleteCustomHostname(c.env.CF_ZONE_ID, c.env.CF_API_TOKEN, domain.cf_hostname_id);

  // Delete KV routing entry
  await c.env.ROUTING.delete(`domain:${domain.hostname}`);

  // Delete DB record
  await deleteDomain(c.env.DB, domain.id);

  return c.json({ ok: true });
});

export default app;
