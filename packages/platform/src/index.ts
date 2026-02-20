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
  getProjectsByUserId,
  getAllUsersWithPlan,
  suspendUser,
  unsuspendUser,
} from "./db";
import { queryProjectUsage } from "./routes/usage";
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
app.get("/me", (c) => c.json({ login: c.get("userLogin") }));
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

async function scheduled(
  _controller: ScheduledController,
  env: PlatformEnv["Bindings"],
  _ctx: ExecutionContext,
): Promise<void> {
  const db = createDb(env.DB);

  // Query all users, check their usage against plan limits
  const allUsers = await getAllUsersWithPlan(db);

  for (const user of allUsers) {
    const limits = getPlanLimits(user.plan);
    if (limits.requestsPerMonth === 0) continue; // unlimited

    const userProjects = await getProjectsByUserId(db, user.id);
    if (userProjects.length === 0) continue;

    const since = getCurrentBillingPeriodStart(user.billing_cycle_start);

    // Sum usage across all user's projects
    let totalRequests = 0;
    for (const project of userProjects) {
      const usage = await queryProjectUsage(env.CF_ACCOUNT_ID, env.CF_API_TOKEN, project.id, since);
      totalRequests += usage.requests;
    }

    const exceeded = !isWithinLimit(limits.requestsPerMonth, totalRequests);

    // Update suspension status for all user's projects
    for (const project of userProjects) {
      const routingRaw = await env.ROUTING.get(project.slug);
      if (!routingRaw) continue;

      const routing = JSON.parse(routingRaw);
      const currentlySuspended = !!routing.suspended;

      if (exceeded && !currentlySuspended) {
        routing.suspended = "requests_exceeded";
        await env.ROUTING.put(project.slug, JSON.stringify(routing));
        await suspendUser(db, user.id, "requests_exceeded");
      } else if (!exceeded && currentlySuspended) {
        delete routing.suspended;
        await env.ROUTING.put(project.slug, JSON.stringify(routing));
        await unsuspendUser(db, user.id);
      }
    }
  }
}

export { app, scheduled };

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<PlatformEnv["Bindings"]>;
