import type { MiddlewareHandler } from 'hono';
import { verifyJwt } from '../auth/jwt.ts';
import { getUser } from '../db.ts';
import { type ApiEnv, isDevBypass } from '../env.ts';
import { users } from '../schema.ts';
import { isAdminSuspended } from '../suspension.ts';

export const authMiddleware: MiddlewareHandler<ApiEnv> = async (c, next) => {
  if (isDevBypass(c.env)) {
    const first = await c
      .get('db')
      .select()
      .from(users)
      .limit(1)
      .then((r) => r[0]);
    if (first) {
      c.set('user', first);
      return next();
    }
  }

  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const token = header.slice(7);
  const payload = await verifyJwt(token, c.env.JWT_SECRET, 'api');
  if (!payload) {
    return c.json({ error: 'invalid or expired token' }, 401);
  }

  const user = await getUser(c.get('db'), payload.sub);
  if (!user) {
    return c.json({ error: 'user not found' }, 401);
  }
  if (isAdminSuspended(user.suspended_reason)) {
    return c.json({ error: 'account suspended' }, 403);
  }

  c.set('user', user);
  await next();
};
