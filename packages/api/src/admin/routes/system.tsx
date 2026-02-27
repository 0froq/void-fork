import type { Handler } from "hono";
import type { ApiEnv } from "../../env";
import { getSystemStats, getAllProjectsWithOwner } from "../../db";
import { DashboardPage } from "../views/dashboard";
import { SITE_DOMAIN } from "../../constants";

export const dashboardHandler: Handler<ApiEnv> = async (c) => {
  const [stats, projects] = await Promise.all([
    getSystemStats(c.get("db")),
    getAllProjectsWithOwner(c.get("db"), 10, 0),
  ]);
  const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;
  return c.html(
    <DashboardPage
      stats={stats}
      projects={projects}
      siteDomain={siteDomain}
      username={c.get("userLogin")}
    />,
  );
};
