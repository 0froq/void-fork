import { Hono } from "hono";
import type { ApiEnv } from "../../env";
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
  deleteProjectCascade,
  deleteUser,
} from "../../db";
import { cleanupProjectResources } from "../../provisioning/cleanup";
import { PLAN_LIMITS, getCurrentBillingPeriodStart, type PlanId } from "../../tiers";
import { queryProjectUsage } from "../../routes/usage";
import { UsersListPage } from "../views/users-list";
import { UserDetailPage } from "../views/user-detail";

const PAGE_SIZE = 20;
const app = new Hono<ApiEnv>();

// GET /users
app.get("/", async (c) => {
  const search = c.req.query("search");
  if (search) {
    const users = await searchUsers(c.get("db"), search);
    return c.html(<UsersListPage users={users} search={search} username={c.get("userLogin")} />);
  }
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const [users, total] = await Promise.all([
    getAllUsers(c.get("db"), PAGE_SIZE, offset),
    countUsers(c.get("db")),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return c.html(
    <UsersListPage
      users={users}
      page={page}
      totalPages={totalPages}
      username={c.get("userLogin")}
    />,
  );
});

// GET /users/:id
app.get("/:id", async (c) => {
  const user = await getUser(c.get("db"), c.req.param("id"));
  if (!user) {
    return c.html("<h1>User not found</h1>", 404);
  }
  const [projects, deploysToday] = await Promise.all([
    getProjectsByUserId(c.get("db"), user.id),
    countUserDeploymentsToday(c.get("db"), user.id),
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
      username={c.get("userLogin")}
    />,
  );
});

// POST /users/:id/plan
app.post("/:id/plan", async (c) => {
  const user = await getUser(c.get("db"), c.req.param("id"));
  if (!user) {
    return c.html("<h1>User not found</h1>", 404);
  }
  const body = await c.req.parseBody();
  const plan = body.plan as string;
  if (!plan || !(plan in PLAN_LIMITS)) {
    return c.html("<h1>Invalid plan</h1>", 400);
  }
  await updateUserPlan(c.get("db"), user.id, plan as PlanId);
  return c.redirect(`/admin/users/${user.id}`);
});

// POST /users/:id/suspend
app.post("/:id/suspend", async (c) => {
  const user = await getUser(c.get("db"), c.req.param("id"));
  if (!user) {
    return c.html("<h1>User not found</h1>", 404);
  }
  const body = await c.req.parseBody();
  const reason = (body.reason as string) || "admin_suspended";
  await suspendUser(c.get("db"), user.id, reason);

  // Suspend all user's projects in KV
  const projects = await getProjectsByUserId(c.get("db"), user.id);
  for (const project of projects) {
    const routingRaw = await c.env.ROUTING.get(project.slug);
    if (!routingRaw) continue;
    const routing = JSON.parse(routingRaw);
    routing.suspended = reason;
    await c.env.ROUTING.put(project.slug, JSON.stringify(routing));
  }

  return c.redirect(`/admin/users/${user.id}`);
});

// POST /users/:id/unsuspend
app.post("/:id/unsuspend", async (c) => {
  const user = await getUser(c.get("db"), c.req.param("id"));
  if (!user) {
    return c.html("<h1>User not found</h1>", 404);
  }
  await unsuspendUser(c.get("db"), user.id);

  // Unsuspend all user's projects in KV
  const projects = await getProjectsByUserId(c.get("db"), user.id);
  for (const project of projects) {
    const routingRaw = await c.env.ROUTING.get(project.slug);
    if (!routingRaw) continue;
    const routing = JSON.parse(routingRaw);
    delete routing.suspended;
    await c.env.ROUTING.put(project.slug, JSON.stringify(routing));
  }

  return c.redirect(`/admin/users/${user.id}`);
});

// POST /users/:id/delete
app.post("/:id/delete", async (c) => {
  const user = await getUser(c.get("db"), c.req.param("id"));
  if (!user) {
    return c.html("<h1>User not found</h1>", 404);
  }
  const projects = await getProjectsByUserId(c.get("db"), user.id);
  for (const project of projects) {
    await cleanupProjectResources(c, project.id, project);
    await deleteProjectCascade(c.get("db"), project.id);
  }
  await deleteUser(c.get("db"), user.id);
  return c.redirect("/admin/users");
});

export default app;
