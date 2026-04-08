import { getUser } from '@voidcloud/api/db';
import { getPlanLimits, type PlanLimits } from '@voidcloud/api/tiers';
import { defineHandler } from 'void';

export type Props = {
  user: {
    id: string;
    login: string;
    email: string | null;
    provider: string;
    plan: string;
    billing_cycle_start: string;
    limits: PlanLimits;
  };
};

export const loader = defineHandler<Props>(async (c) => {
  const user = await getUser(c.get('db'), c.get('userId'));
  if (!user) return c.redirect('/login');
  const limits = getPlanLimits(user.plan);
  return {
    user: {
      id: user.id,
      login: user.login,
      email: user.email,
      provider: user.provider,
      plan: user.plan,
      billing_cycle_start: user.billing_cycle_start,
      limits,
    },
  };
});
