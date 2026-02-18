import { Hono } from "hono";
import type { AdminEnv } from "../env";
import { getSystemStats } from "@vite-cloud/platform/db";
import { DashboardPage } from "../views/dashboard";

const app = new Hono<AdminEnv>();

// GET / (dashboard home)
app.get("/", async (c) => {
  const stats = await getSystemStats(c.env.DB);
  return c.html(<DashboardPage stats={stats} />);
});

export default app;
