import type { Handler } from "hono";
import type { PlatformEnv } from "../../env";
import { getSystemStats, getAllProjectsWithOwner } from "../../db";
import { DashboardPage } from "../views/dashboard";

export const dashboardHandler: Handler<PlatformEnv> = async (c) => {
  const [stats, projects] = await Promise.all([
    getSystemStats(c.get("db")),
    getAllProjectsWithOwner(c.get("db"), 10, 0),
  ]);
  return c.html(<DashboardPage stats={stats} projects={projects} username={c.get("userLogin")} />);
};
