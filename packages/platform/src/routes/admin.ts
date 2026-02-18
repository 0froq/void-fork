import { Hono } from "hono";
import type { PlatformEnv } from "../env";
import {
  getAllUsers,
  searchUsers,
  getUser,
  getProjectsByUserId,
  updateUserPlan,
  suspendUser,
  unsuspendUser,
  getSystemStats,
  getProject,
  getProjectDeployments,
  getProjectResources,
  getAllProjects,
} from "../db";
import { PLAN_LIMITS } from "../tiers";

const app = new Hono<PlatformEnv>();

// GET /admin/users
app.get("/users", async (c) => {
  const search = c.req.query("search");
  if (search) {
    const users = await searchUsers(c.env.DB, search);
    return c.json({ users });
  }

  const limit = Number(c.req.query("limit") ?? "50");
  const offset = Number(c.req.query("offset") ?? "0");
  const users = await getAllUsers(c.env.DB, limit, offset);
  return c.json({ users });
});

// GET /admin/users/:id
app.get("/users/:id", async (c) => {
  const user = await getUser(c.env.DB, c.req.param("id"));
  if (!user) {
    return c.json({ error: "user not found" }, 404);
  }
  const projects = await getProjectsByUserId(c.env.DB, user.id);
  return c.json({ user, projects });
});

// POST /admin/users/:id/plan
app.post("/users/:id/plan", async (c) => {
  const user = await getUser(c.env.DB, c.req.param("id"));
  if (!user) {
    return c.json({ error: "user not found" }, 404);
  }

  const body = await c.req.json<{ plan: string }>();
  if (!body.plan || !(body.plan in PLAN_LIMITS)) {
    return c.json({ error: "invalid plan" }, 400);
  }

  await updateUserPlan(c.env.DB, user.id, body.plan);
  return c.json({ ok: true, plan: body.plan });
});

// POST /admin/users/:id/suspend
app.post("/users/:id/suspend", async (c) => {
  const user = await getUser(c.env.DB, c.req.param("id"));
  if (!user) {
    return c.json({ error: "user not found" }, 404);
  }

  const body = await c.req.json<{ reason?: string }>();
  const reason = body.reason ?? "admin_suspended";
  await suspendUser(c.env.DB, user.id, reason);

  // Suspend all user's projects in KV
  const projects = await getProjectsByUserId(c.env.DB, user.id);
  for (const project of projects) {
    const routingRaw = await c.env.ROUTING.get(project.slug);
    if (!routingRaw) continue;
    const routing = JSON.parse(routingRaw);
    routing.suspended = reason;
    await c.env.ROUTING.put(project.slug, JSON.stringify(routing));
  }

  return c.json({ ok: true });
});

// POST /admin/users/:id/unsuspend
app.post("/users/:id/unsuspend", async (c) => {
  const user = await getUser(c.env.DB, c.req.param("id"));
  if (!user) {
    return c.json({ error: "user not found" }, 404);
  }

  await unsuspendUser(c.env.DB, user.id);

  // Unsuspend all user's projects in KV
  const projects = await getProjectsByUserId(c.env.DB, user.id);
  for (const project of projects) {
    const routingRaw = await c.env.ROUTING.get(project.slug);
    if (!routingRaw) continue;
    const routing = JSON.parse(routingRaw);
    delete routing.suspended;
    await c.env.ROUTING.put(project.slug, JSON.stringify(routing));
  }

  return c.json({ ok: true });
});

// GET /admin/projects
app.get("/projects", async (c) => {
  const limit = Number(c.req.query("limit") ?? "50");
  const offset = Number(c.req.query("offset") ?? "0");
  const projects = await getAllProjects(c.env.DB, limit, offset);
  return c.json({ projects });
});

// GET /admin/projects/:id
app.get("/projects/:id", async (c) => {
  const project = await getProject(c.env.DB, c.req.param("id"));
  if (!project) {
    return c.json({ error: "project not found" }, 404);
  }
  const [deployments, resources] = await Promise.all([
    getProjectDeployments(c.env.DB, project.id, 10),
    getProjectResources(c.env.DB, project.id),
  ]);
  return c.json({ project, deployments, resources });
});

// GET /admin/stats
app.get("/stats", async (c) => {
  const stats = await getSystemStats(c.env.DB);
  return c.json(stats);
});

export default app;
