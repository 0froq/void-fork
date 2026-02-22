import { Hono } from "hono";
import type { PlatformEnv } from "./env";
import auth from "./routes/auth";
import projects from "./routes/projects";
import deploy from "./routes/deploy";
import deleteRoute from "./routes/delete";
import revalidate from "./routes/revalidate";
import secrets from "./routes/secrets";
import domains from "./routes/domains";
import usage from "./routes/usage";
import { authMiddleware } from "./middleware/auth";
import adminLogin from "./admin/routes/login";
import { adminAuthMiddleware } from "./admin/middleware/auth";
import { dashboardHandler } from "./admin/routes/system";
import adminUsers from "./admin/routes/users";
import adminProjects from "./admin/routes/projects";
import adminDeployments from "./admin/routes/deployments";
import {
  createDb,
  getUser,
  getUsersWithProjectsBatch,
  suspendUser,
  unsuspendUserIfReason,
} from "./db";
import type { Db } from "./db";
import { queryProjectUsage, queryProjectAiUsage } from "./routes/usage";
import { getCurrentBillingPeriodStart, getPlanLimits, isWithinLimit } from "./tiers";

const app = new Hono<PlatformEnv>();

// Drizzle middleware — creates a Db instance per request
app.use("*", async (c, next) => {
  c.set("db", createDb(c.env.DB));
  await next();
});

app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/auth", auth);
app.use("/me", authMiddleware);
app.get("/me", async (c) => {
  const user = await getUser(c.get("db"), c.get("userId"));
  if (!user) {
    return c.json({ error: "user not found" }, 404);
  }
  const limits = getPlanLimits(user.plan);
  return c.json({
    id: user.id,
    login: user.login,
    email: user.email,
    provider: user.provider,
    plan: user.plan,
    billing_cycle_start: user.billing_cycle_start,
    limits,
  });
});
app.use("/projects/*", authMiddleware);
app.route("/projects", projects);
app.route("/projects", deploy);
app.route("/projects", deleteRoute);
app.route("/projects", revalidate);
app.route("/projects", secrets);
app.route("/projects", domains);
app.route("/projects", usage);
app.use("/usage", authMiddleware);
app.route("/usage", usage);
// Admin dashboard (HTML, cookie-based auth)
app.route("/admin", adminLogin);
app.use("/admin/*", adminAuthMiddleware);
app.get("/admin/", adminAuthMiddleware, dashboardHandler);
app.route("/admin/users", adminUsers);
app.route("/admin/projects", adminProjects);
app.route("/admin/deployments", adminDeployments);

const BATCH_SIZE = 50;
const ANALYTICS_CONCURRENCY = 10;

async function scheduled(
  _controller: ScheduledController,
  env: PlatformEnv["Bindings"],
  _ctx: ExecutionContext,
): Promise<void> {
  const db = createDb(env.DB);

  let offset = 0;
  while (true) {
    const batch = await getUsersWithProjectsBatch(db, BATCH_SIZE, offset);
    if (batch.length === 0) break;

    await Promise.allSettled(
      batch.map(({ user, projects }) => processUserUsage(env, db, user, projects)),
    );

    offset += BATCH_SIZE;
  }
}

async function processUserUsage(
  env: PlatformEnv["Bindings"],
  db: Db,
  user: { id: string; plan: string; billing_cycle_start: string; suspended_reason: string | null },
  userProjects: { id: string; slug: string }[],
): Promise<void> {
  const limits = getPlanLimits(user.plan);
  if (limits.requestsPerMonth === 0) return; // unlimited
  if (userProjects.length === 0) return;

  const since = getCurrentBillingPeriodStart(user.billing_cycle_start);

  // Query analytics for all projects with bounded concurrency
  const usages = await asyncPool(userProjects, ANALYTICS_CONCURRENCY, (project) =>
    queryProjectUsage(env.CF_ACCOUNT_ID, env.CF_API_TOKEN, project.id, since),
  );

  let totalRequests = 0;
  for (const usage of usages) {
    totalRequests += usage.requests;
  }

  const exceeded = !isWithinLimit(limits.requestsPerMonth, totalRequests);

  // Update KV routing entries for each project
  for (const project of userProjects) {
    const routingRaw = await env.ROUTING.get(project.slug);
    if (!routingRaw) continue;

    const routing = JSON.parse(routingRaw);

    if (exceeded && !routing.suspended) {
      routing.suspended = "requests_exceeded";
      await env.ROUTING.put(project.slug, JSON.stringify(routing));
    } else if (!exceeded && routing.suspended === "requests_exceeded") {
      delete routing.suspended;
      await env.ROUTING.put(project.slug, JSON.stringify(routing));
    }
    // Leave admin-suspended or other suspension reasons untouched
  }

  // Update DB suspension status
  if (exceeded) {
    await suspendUser(db, user.id, "requests_exceeded");
  } else {
    await unsuspendUserIfReason(db, user.id, "requests_exceeded");
  }

  // --- AI neuron limit enforcement (free tier only) ---
  if (limits.aiNeuronsPerMonth !== 0 && user.plan === "free") {
    const aiUsages = await asyncPool(userProjects, ANALYTICS_CONCURRENCY, (project) =>
      queryProjectAiUsage(env.CF_ACCOUNT_ID, env.CF_API_TOKEN, project.id, since),
    );

    let totalNeurons = 0;
    for (const usage of aiUsages) {
      totalNeurons += usage.neurons;
    }

    const aiExceeded = !isWithinLimit(limits.aiNeuronsPerMonth, totalNeurons);

    for (const project of userProjects) {
      const key = `ai-block:${project.id}`;
      if (aiExceeded) {
        await env.ROUTING.put(key, "1");
      } else {
        await env.ROUTING.delete(key);
      }
    }
  }
}

async function asyncPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export { app, scheduled };

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<PlatformEnv["Bindings"]>;
