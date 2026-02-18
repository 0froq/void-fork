import { Hono } from "hono";
import type { AdminEnv } from "../env";
import {
  getAllUsers,
  searchUsers,
  getUser,
  getProjectsByUserId,
  updateUserPlan,
  suspendUser,
  unsuspendUser,
} from "@vite-cloud/platform/db";
import { PLAN_LIMITS } from "@vite-cloud/platform/tiers";
import { UsersListPage } from "../views/users-list";
import { UserDetailPage } from "../views/user-detail";

const app = new Hono<AdminEnv>();

// GET /users
app.get("/", async (c) => {
  const search = c.req.query("search");
  const users = search ? await searchUsers(c.env.DB, search) : await getAllUsers(c.env.DB, 50, 0);
  return c.html(<UsersListPage users={users} search={search} />);
});

// GET /users/:id
app.get("/:id", async (c) => {
  const user = await getUser(c.env.DB, c.req.param("id"));
  if (!user) {
    return c.html("<h1>User not found</h1>", 404);
  }
  const projects = await getProjectsByUserId(c.env.DB, user.id);
  return c.html(<UserDetailPage user={user} projects={projects} />);
});

// POST /users/:id/plan
app.post("/:id/plan", async (c) => {
  const user = await getUser(c.env.DB, c.req.param("id"));
  if (!user) {
    return c.html("<h1>User not found</h1>", 404);
  }
  const body = await c.req.parseBody();
  const plan = body.plan as string;
  if (!plan || !(plan in PLAN_LIMITS)) {
    return c.html("<h1>Invalid plan</h1>", 400);
  }
  await updateUserPlan(c.env.DB, user.id, plan);
  return c.redirect(`/users/${user.id}`);
});

// POST /users/:id/suspend
app.post("/:id/suspend", async (c) => {
  const user = await getUser(c.env.DB, c.req.param("id"));
  if (!user) {
    return c.html("<h1>User not found</h1>", 404);
  }
  const body = await c.req.parseBody();
  const reason = (body.reason as string) || "admin_suspended";
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

  return c.redirect(`/users/${user.id}`);
});

// POST /users/:id/unsuspend
app.post("/:id/unsuspend", async (c) => {
  const user = await getUser(c.env.DB, c.req.param("id"));
  if (!user) {
    return c.html("<h1>User not found</h1>", 404);
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

  return c.redirect(`/users/${user.id}`);
});

export default app;
