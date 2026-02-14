import { Hono } from "hono";
import type { PlatformEnv } from "../env";
import { createProject, getProject, getProjectBySlug, getProjectsByUserId } from "../db";

const app = new Hono<PlatformEnv>();

// List all projects for the current user
app.get("/", async (c) => {
  // Hardcoded dev user for Phase 2 (auth comes later)
  const DEV_USER_ID = "user_dev000000000";
  const projects = await getProjectsByUserId(c.env.DB, DEV_USER_ID);
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

  // Hardcoded dev user for Phase 2 (auth comes later)
  const DEV_USER_ID = "user_dev000000000";

  const project = await createProject(c.env.DB, DEV_USER_ID, body.slug, body.name);
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

export default app;
