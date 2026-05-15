import { Hono } from 'hono';
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
  deleteUser,
} from '../../db.ts';
import type { ApiEnv } from '../../env.ts';
import { teardownProject } from '../../provisioning/cleanup.ts';
import { getRequestsDataset, queryBatchProjectUsage, ZERO_USAGE } from '../../routes/usage.ts';
import { PLAN_LIMITS, getCurrentBillingPeriodStart, type PlanId } from '../../tiers.ts';
import { UserDetailPage } from '../views/user-detail.tsx';
import { UsersListPage } from '../views/users-list.tsx';

const PAGE_SIZE = 20;
const app = new Hono<ApiEnv>();

// GET /users
app.get('/', async (context) => {
  const search = context.req.query('search');
  if (search) {
    const users = await searchUsers(context.get('db'), search);
    return context.html(
      <UsersListPage users={users} search={search} username={context.get('user').login} />,
    );
  }
  const page = Math.max(1, parseInt(context.req.query('page') ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const [users, total] = await Promise.all([
    getAllUsers(context.get('db'), PAGE_SIZE, offset),
    countUsers(context.get('db')),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return context.html(
    <UsersListPage
      users={users}
      page={page}
      totalPages={totalPages}
      username={context.get('user').login}
    />,
  );
});

// GET /users/:id
app.get('/:id', async (context) => {
  const user = await getUser(context.get('db'), context.req.param('id'));
  if (!user) {
    return context.html('<h1>User not found</h1>', 404);
  }
  const [projects, deploysToday] = await Promise.all([
    getProjectsByUserId(context.get('db'), user.id),
    countUserDeploymentsToday(context.get('db'), user.id),
  ]);

  const since = user.billing_cycle_start
    ? getCurrentBillingPeriodStart(user.billing_cycle_start)
    : new Date();
  const usageMap = await queryBatchProjectUsage(
    context.env.CF_ACCOUNT_ID,
    context.env.CF_API_TOKEN,
    getRequestsDataset(context.env),
    projects.map((p) => p.id),
    since,
  );
  const projectUsages = projects.map((p) => ({
    projectId: p.id,
    slug: p.slug,
    ...(usageMap.get(p.id) ?? ZERO_USAGE),
  }));
  const totalRequests = projectUsages.reduce((sum, u) => sum + u.requests, 0);
  const totalBandwidth = projectUsages.reduce((sum, u) => sum + u.bandwidthBytes, 0);

  return context.html(
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
      username={context.get('user').login}
    />,
  );
});

// POST /users/:id/plan
app.post('/:id/plan', async (context) => {
  const user = await getUser(context.get('db'), context.req.param('id'));
  if (!user) {
    return context.html('<h1>User not found</h1>', 404);
  }
  const body = await context.req.parseBody();
  const plan = body.plan as string;
  if (!plan || !(plan in PLAN_LIMITS)) {
    return context.html('<h1>Invalid plan</h1>', 400);
  }
  await updateUserPlan(context.get('db'), user.id, plan as PlanId);
  return context.redirect(`/admin/users/${user.id}`);
});

// POST /users/:id/suspend
app.post('/:id/suspend', async (context) => {
  const user = await getUser(context.get('db'), context.req.param('id'));
  if (!user) {
    return context.html('<h1>User not found</h1>', 404);
  }
  const body = await context.req.parseBody();
  const reason = (body.reason as string) || 'admin_suspended';
  await suspendUser(context.get('db'), user.id, reason);

  // Suspend all user's projects in KV
  const projects = await getProjectsByUserId(context.get('db'), user.id);
  for (const project of projects) {
    const routingRaw = await context.env.ROUTING.get(project.slug);
    if (!routingRaw) {
      continue;
    }
    const routing = JSON.parse(routingRaw);
    routing.suspended = reason;
    await context.env.ROUTING.put(project.slug, JSON.stringify(routing));
  }

  return context.redirect(`/admin/users/${user.id}`);
});

// POST /users/:id/unsuspend
app.post('/:id/unsuspend', async (context) => {
  const user = await getUser(context.get('db'), context.req.param('id'));
  if (!user) {
    return context.html('<h1>User not found</h1>', 404);
  }
  await unsuspendUser(context.get('db'), user.id);

  // Unsuspend all user's projects in KV
  const projects = await getProjectsByUserId(context.get('db'), user.id);
  for (const project of projects) {
    const routingRaw = await context.env.ROUTING.get(project.slug);
    if (!routingRaw) {
      continue;
    }
    const routing = JSON.parse(routingRaw);
    delete routing.suspended;
    await context.env.ROUTING.put(project.slug, JSON.stringify(routing));
  }

  return context.redirect(`/admin/users/${user.id}`);
});

// POST /users/:id/delete
app.post('/:id/delete', async (context) => {
  const user = await getUser(context.get('db'), context.req.param('id'));
  if (!user) {
    return context.html('<h1>User not found</h1>', 404);
  }
  const projects = await getProjectsByUserId(context.get('db'), user.id);
  for (const project of projects) {
    await teardownProject(context, project.id, project);
  }
  await deleteUser(context.get('db'), user.id);
  return context.redirect('/admin/users');
});

export default app;
