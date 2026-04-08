import { Hono } from 'hono';
import type { ApiEnv } from '../env';
import { getPlanLimits } from '../tiers';

const app = new Hono<ApiEnv>()

  .get('/', async (c) => {
    const user = c.get('user');
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
