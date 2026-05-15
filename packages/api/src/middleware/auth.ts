import type { MiddlewareHandler } from 'hono';
import { verifyJwt } from '../auth/jwt.ts';
import { getUser } from '../db.ts';
import { type ApiEnv, isDevBypass } from '../env.ts';
import { users } from '../schema.ts';
import { isAdminSuspended } from '../suspension.ts';

export const authMiddleware: MiddlewareHandler<ApiEnv> = async (context, next) => {
  if (isDevBypass(context.env)) {
    const first = await context
      .get('db')
      .select()
      .from(users)
      .limit(1)
      .then((rows) => rows[0]);
    if (first) {
      context.set('user', first);
      return next();
    }
  }

  const header = context.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return context.json({ error: 'unauthorized' }, 401);
  }

  const token = header.slice(7);
  const payload = await verifyJwt(token, context.env.JWT_SECRET, 'api');
  if (!payload) {
    return context.json({ error: 'invalid or expired token' }, 401);
  }

  const user = await getUser(context.get('db'), payload.sub);
  if (!user) {
    return context.json({ error: 'user not found' }, 401);
  }
  if (isAdminSuspended(user.suspended_reason)) {
    return context.json({ error: 'account suspended' }, 403);
  }

  context.set('user', user);
  await next();
};
