import { Hono } from "hono";
import type { AdminEnv } from "../env";
import { getSystemStats, getAllProjectsWithOwner } from "@vite-cloud/platform/db";
import { DashboardPage } from "../views/dashboard";

const app = new Hono<AdminEnv>();

// GET / (dashboard home)
app.get("/", async (c) => {
  const [stats, projects] = await Promise.all([
    getSystemStats(c.env.DB),
    getAllProjectsWithOwner(c.env.DB, 10, 0),
  ]);
  return c.html(<DashboardPage stats={stats} projects={projects} />);
});

export default app;
