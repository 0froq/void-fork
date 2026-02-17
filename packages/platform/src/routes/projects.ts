import { Hono } from "hono";
import type { PlatformEnv } from "../env";
import {
  createProject,
  getProject,
  getProjectBySlug,
  getProjectsByUserId,
  getProjectDeployments,
  getProjectResources,
} from "../db";
import { queryD1 } from "../migrations/remote-runner";

const app = new Hono<PlatformEnv>();

// List all projects for the current user
app.get("/", async (c) => {
  const userId = c.get("userId");
  const projects = await getProjectsByUserId(c.env.DB, userId);
  return c.json(projects);
});

// Create a new project
app.post("/", async (c) => {
  const body = await c.req.json<{ slug: string; name: string }>();

  if (!body.slug || !body.name) {
    return c.json({ error: "slug and name are required" }, 400);
  }

  // Validate slug format: lowercase alphanumeric + dashes
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(body.slug) && body.slug.length > 1) {
    return c.json({ error: "slug must be lowercase alphanumeric with dashes" }, 400);
  }

  // Check for slug uniqueness
  const existing = await getProjectBySlug(c.env.DB, body.slug);
  if (existing) {
    return c.json({ error: "slug already taken" }, 409);
  }

  const userId = c.get("userId");
  const project = await createProject(c.env.DB, userId, body.slug, body.name);
  return c.json(project, 201);
});

// Get project by ID
app.get("/:id", async (c) => {
  const project = await getProject(c.env.DB, c.req.param("id"));
  if (!project) {
    return c.json({ error: "project not found" }, 404);
  }
  return c.json(project);
});

// List deployments for a project
app.get("/:id/deployments", async (c) => {
  const project = await getProject(c.env.DB, c.req.param("id"));
  if (!project) {
    return c.json({ error: "project not found" }, 404);
  }

  if (project.user_id !== c.get("userId")) {
    return c.json({ error: "forbidden" }, 403);
  }

  const deployments = await getProjectDeployments(c.env.DB, project.id);
  return c.json(deployments);
});

// Get migration status for a project
app.get("/:id/migrations", async (c) => {
  const project = await getProject(c.env.DB, c.req.param("id"));
  if (!project) {
    return c.json({ error: "project not found" }, 404);
  }

  if (project.user_id !== c.get("userId")) {
    return c.json({ error: "forbidden" }, 403);
  }

  const resources = await getProjectResources(c.env.DB, project.id);
  const d1Resource = resources.find((r) => r.type === "d1");
  if (!d1Resource) {
    return c.json({ applied: [] });
  }

  try {
    const result = await queryD1(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, d1Resource.cf_id, {
      sql: "SELECT name, applied_at FROM _migrations ORDER BY name",
    });
    return c.json({
      applied: result.results.map((r) => ({
        name: r.name as string,
        applied_at: r.applied_at as string,
      })),
    });
  } catch {
    return c.json({ applied: [] });
  }
});

export default app;
