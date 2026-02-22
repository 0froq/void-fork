import { Hono } from "hono";
import type { PlatformEnv } from "./env";
import auth from "./routes/auth";
import projects from "./routes/projects";
import deploy from "./routes/deploy";
import deleteRoute from "./routes/delete";
import revalidate from "./routes/revalidate";
import secrets from "./routes/secrets";
import domains from "./routes/domains";
import { projectUsage, accountUsage } from "./routes/usage";
import { authMiddleware } from "./middleware/auth";
import adminLogin from "./admin/routes/login";
import { adminAuthMiddleware } from "./admin/middleware/auth";
import { dashboardHandler } from "./admin/routes/system";
import adminUsers from "./admin/routes/users";
import adminProjects from "./admin/routes/projects";
import adminDeployments from "./admin/routes/deployments";
import me from "./routes/me";
import { createDb, getUsersWithProjectsBatch, suspendUser, unsuspendUserIfReason } from "./db";
import type { Db } from "./db";
import { queryProjectUsage, queryProjectAiUsage } from "./routes/usage";
import { getCurrentBillingPeriodStart, getPlanLimits, isWithinLimit } from "./tiers";

const app = new Hono<PlatformEnv>()

  // Drizzle middleware — creates a Db instance per request
  .use("*", async (c, next) => {
    c.set("db", createDb(c.env.DB));
    await next();
  })

  .get("/health", (c) => c.json({ status: "ok" }))
  .route("/auth", auth)
  .use("/me", authMiddleware)
  .route("/me", me)
  .use("/projects/*", authMiddleware)
  .route("/projects", projects)
  .route("/projects", deploy)
  .route("/projects", deleteRoute)
  .route("/projects", revalidate)
  .route("/projects", secrets)
  .route("/projects", domains)
  .route("/projects", projectUsage)
  .use("/usage", authMiddleware)
  .route("/usage", accountUsage);

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

export type AppType = typeof app;
export { app, scheduled };

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<PlatformEnv["Bindings"]>;
