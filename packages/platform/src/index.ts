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
import { getProjectsByUserId } from "./db";
import { queryProjectUsage } from "./routes/usage";
import { getCurrentBillingPeriodStart, getPlanLimits, isWithinLimit } from "./tiers";

const app = new Hono<PlatformEnv>();

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

async function scheduled(
  _controller: ScheduledController,
  env: PlatformEnv["Bindings"],
  _ctx: ExecutionContext,
): Promise<void> {
  // Query all users, check their usage against plan limits
  const users = await env.DB.prepare("SELECT id, plan, billing_cycle_start FROM users").all<{
    id: string;
    plan: string;
    billing_cycle_start: string;
  }>();

  for (const user of users.results) {
    const limits = getPlanLimits(user.plan);
    if (limits.requestsPerMonth === 0) continue; // unlimited

    const projects = await getProjectsByUserId(env.DB, user.id);
    if (projects.length === 0) continue;

    const since = getCurrentBillingPeriodStart(user.billing_cycle_start);

    // Sum usage across all user's projects
    let totalRequests = 0;
    for (const project of projects) {
      const usage = await queryProjectUsage(env.CF_ACCOUNT_ID, env.CF_API_TOKEN, project.id, since);
      totalRequests += usage.requests;
    }

    const exceeded = !isWithinLimit(limits.requestsPerMonth, totalRequests);

    // Update suspension status for all user's projects
    for (const project of projects) {
      const routingRaw = await env.ROUTING.get(project.slug);
      if (!routingRaw) continue;

      const routing = JSON.parse(routingRaw);
      const currentlySuspended = !!routing.suspended;

      if (exceeded && !currentlySuspended) {
        routing.suspended = "requests_exceeded";
        await env.ROUTING.put(project.slug, JSON.stringify(routing));
        await env.DB.prepare("UPDATE users SET suspended_reason = ? WHERE id = ?")
          .bind("requests_exceeded", user.id)
          .run();
      } else if (!exceeded && currentlySuspended) {
        delete routing.suspended;
        await env.ROUTING.put(project.slug, JSON.stringify(routing));
        await env.DB.prepare("UPDATE users SET suspended_reason = NULL WHERE id = ?")
          .bind(user.id)
          .run();
      }
    }
  }
}

export { app, scheduled };

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<PlatformEnv["Bindings"]>;
