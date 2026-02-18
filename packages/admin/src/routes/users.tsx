import { Hono } from "hono";
import type { AdminEnv } from "../env";
import {
  getAllUsers,
  countUsers,
  searchUsers,
  getUser,
  getProjectsByUserId,
  updateUserPlan,
  suspendUser,
  unsuspendUser,
  countUserDeploymentsToday,
} from "@vite-cloud/platform/db";
import { PLAN_LIMITS, getCurrentBillingPeriodStart } from "@vite-cloud/platform/tiers";
import { queryProjectUsage } from "@vite-cloud/platform/usage";
import { UsersListPage } from "../views/users-list";
import { UserDetailPage } from "../views/user-detail";

const PAGE_SIZE = 20;
const app = new Hono<AdminEnv>();

// GET /users
app.get("/", async (c) => {
  const search = c.req.query("search");
  if (search) {
    const users = await searchUsers(c.env.DB, search);
    return c.html(<UsersListPage users={users} search={search} />);
  }
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const [users, total] = await Promise.all([
    getAllUsers(c.env.DB, PAGE_SIZE, offset),
    countUsers(c.env.DB),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return c.html(<UsersListPage users={users} page={page} totalPages={totalPages} />);
});

// GET /users/:id
app.get("/:id", async (c) => {
  const user = await getUser(c.env.DB, c.req.param("id"));
  if (!user) {
    return c.html("<h1>User not found</h1>", 404);
  }
  const [projects, deploysToday] = await Promise.all([
    getProjectsByUserId(c.env.DB, user.id),
    countUserDeploymentsToday(c.env.DB, user.id),
  ]);

  const since = user.billing_cycle_start
    ? getCurrentBillingPeriodStart(user.billing_cycle_start)
    : new Date();
  const projectUsages = await Promise.all(
    projects.map(async (p) => {
      const usage = await queryProjectUsage(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, p.id, since);
      return { projectId: p.id, slug: p.slug, ...usage };
    }),
  );
  const totalRequests = projectUsages.reduce((sum, u) => sum + u.requests, 0);
  const totalBandwidth = projectUsages.reduce((sum, u) => sum + u.bandwidthBytes, 0);

  return c.html(
    <UserDetailPage
      user={user}
      projects={projects}
      deploysToday={deploysToday}
      usage={{
        billingPeriodStart: since.toISOString(),
        totalRequests,
        totalBandwidth,
        projects: projectUsages,
      }}
    />,
  );
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
