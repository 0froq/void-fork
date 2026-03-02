import { Hono } from "hono";
import type { ApiEnv } from "./env";
import { UsageCounter } from "./usage-counter";
import { processUsageEventBatch } from "./usage-queue";
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
import { dashboardHandler, adminSystem } from "./admin/routes/system";
import adminUsers from "./admin/routes/users";
import adminProjects from "./admin/routes/projects";
import adminDeployments from "./admin/routes/deployments";
import adminSignupControl from "./admin/routes/signup-control";
import me from "./routes/me";
import { createDb, getUsersWithProjectsBatch, unsuspendUserIfReason, type Db } from "./db";
import { getCurrentBillingPeriodStart, getPlanLimits } from "./tiers";

const app = new Hono<ApiEnv>()

  // Drizzle middleware — creates a Db instance per request
  .use("*", async (c, next) => {
    c.set("db", createDb(c.env.HYPERDRIVE.connectionString));
    await next();
  })

  .get("/health", (c) => c.json({ status: "ok" }))
  .get("/signup-restricted", (c) =>
    c.html(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Private Beta - Void</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fafafa}.card{text-align:center;max-width:400px;padding:40px}h1{font-size:1.25rem;margin-bottom:12px}p{color:#666}</style>
</head><body>
<div class="card"><h1>Private Beta</h1><p>Sorry, we are still in private beta and your login is not currently in the allowed list. Check back later!</p></div>
</body></html>`),
  )
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
app.route("/admin/signup-control", adminSignupControl);
app.route("/admin", adminSystem);

const BATCH_SIZE = 50;

async function scheduled(
  _controller: ScheduledController,
  env: ApiEnv["Bindings"],
  _ctx: ExecutionContext,
): Promise<void> {
  const db = createDb(env.HYPERDRIVE.connectionString);

  let offset = 0;
  while (true) {
    const batch = await getUsersWithProjectsBatch(db, BATCH_SIZE, offset);
    if (batch.length === 0) break;

    await Promise.allSettled(
      batch.map(({ user, projects }) => processUserRollover(env, db, user, projects)),
    );

    offset += BATCH_SIZE;
  }
}

async function processUserRollover(
  env: ApiEnv["Bindings"],
  db: Db,
  user: { id: string; plan: string; billing_cycle_start: string; suspended_reason: string | null },
  userProjects: { id: string; slug: string }[],
): Promise<void> {
  const limits = getPlanLimits(user.plan);
  // Skip unlimited plans (no enforcement needed)
  if (limits.requestsPerMonth === 0 && limits.aiNeuronsPerMonth === 0) return;
  if (userProjects.length === 0) return;

  const billingPeriodStart = getCurrentBillingPeriodStart(user.billing_cycle_start).toISOString();
  const projectSlugs: Record<string, string> = {};
  for (const p of userProjects) {
    projectSlugs[p.id] = p.slug;
  }

  const doId = env.USAGE_COUNTER.idFromName(user.id);
  const stub = env.USAGE_COUNTER.get(doId);

  // Send rollover check (DO only resets if period actually changed)
  const rolloverRes = await stub.fetch(
    new Request("https://do/rollover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ billingPeriodStart, plan: user.plan }),
    }),
  );

  if (rolloverRes.ok) {
    const result = await rolloverRes.json<{
      rolled: boolean;
      unsuspendRequests?: boolean;
      unsuspendAi?: boolean;
    }>();

    // If period rolled and user was request-suspended, unsuspend in DB
    if (result.rolled && result.unsuspendRequests) {
      await unsuspendUserIfReason(db, user.id, "requests_exceeded");
    }
  }

  // Initialize DO with current project slugs (handles new users/projects)
  await stub.fetch(
    new Request("https://do/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: user.plan, billingPeriodStart, projectSlugs }),
    }),
  );

  // Backfill userId into old KV routing entries
  for (const project of userProjects) {
    const raw = await env.ROUTING.get(project.slug);
    if (!raw) continue;
    const routing = JSON.parse(raw);
    if (!routing.userId) {
      routing.userId = user.id;
      await env.ROUTING.put(project.slug, JSON.stringify(routing));
    }
  }
}

export { UsageCounter };
export type AppType = typeof app;
export { app, scheduled };

export default {
  fetch: app.fetch,
  scheduled,
  async queue(batch: MessageBatch<unknown>, env: ApiEnv["Bindings"]): Promise<void> {
    await processUsageEventBatch(batch, env);
  },
} satisfies ExportedHandler<ApiEnv["Bindings"]>;
