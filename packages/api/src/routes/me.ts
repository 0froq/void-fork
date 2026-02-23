import { Hono } from "hono";
import type { ApiEnv } from "../env";
import { getUser } from "../db";
import { getPlanLimits } from "../tiers";

const app = new Hono<ApiEnv>()

  .get("/", async (c) => {
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

export default app;
