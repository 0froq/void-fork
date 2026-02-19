import type { Handler } from "hono";
import type { PlatformEnv } from "../../env";
import { getSystemStats, getAllProjectsWithOwner } from "../../db";
import { DashboardPage } from "../views/dashboard";

export const dashboardHandler: Handler<PlatformEnv> = async (c) => {
  const [stats, projects] = await Promise.all([
    getSystemStats(c.env.DB),
    getAllProjectsWithOwner(c.env.DB, 10, 0),
  ]);
  return c.html(<DashboardPage stats={stats} projects={projects} username={c.get("userLogin")} />);
};
