import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { verifyJwt } from '../../auth/jwt.ts';
import { getUser, getFirstAdmin } from '../../db.ts';
import { type ApiEnv, isDevBypass } from '../../env.ts';

export const adminAuthMiddleware: MiddlewareHandler<ApiEnv> = async (c, next) => {
  if (isDevBypass(c.env)) {
    const admin = await getFirstAdmin(c.get('db'));
    if (admin) {
      const user = await getUser(c.get('db'), admin.id);
      if (user) {
        c.set('user', user);
        return next();
      }
    }
  }

  const token = getCookie(c, 'admin_token');
  if (!token) {
    return c.redirect('/admin/login');
  }

  const payload = await verifyJwt(token, c.env.JWT_SECRET, 'admin');
  if (!payload) {
    return c.redirect('/admin/login');
  }

  const user = await getUser(c.get('db'), payload.sub);
  if (!user || user.role !== 'admin') {
    return c.html('<h1>403 Forbidden</h1><p>Admin access required.</p>', 403);
  }

  c.set('user', user);
  await next();
};
