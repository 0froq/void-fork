import { deleteCookie, getCookie } from 'hono/cookie';
import { defineMiddleware } from 'void';
import { getCurrentUser, type API } from '../lib/api.ts';

export type DashboardUser = API<'me'>;

export type DashboardShared = {
  user: DashboardUser | null;
  canAccessDashboard: boolean;
};

declare module 'void' {
  interface CloudContextVariables {
    token: string;
    userId: string;
    dashboardUser: DashboardUser;
    canAccessDashboard: boolean;
    shared: DashboardShared;
  }
}

const PUBLIC_PATHS = new Set(['/login', '/logout']);

function isLocalHost(host: string | undefined): boolean {
  host ??= '';
  return host.startsWith('localhost') || host.startsWith('127.0.0.1');
}

export default defineMiddleware(async (c, next) => {
  const path = c.req.path;

  if (PUBLIC_PATHS.has(path) || path.startsWith('/auth/')) {
    c.set('shared', { user: null, canAccessDashboard: false });
    return next();
  }

  const token = getCookie(c, 'void_token');
  if (!token) {
    c.set('shared', { user: null, canAccessDashboard: false });
    return c.redirect('/login');
  }

  c.set('token', token);
  const user = await getCurrentUser(c);
  if (!user) {
    deleteCookie(c, 'void_token', { path: '/' });
    c.set('shared', { user: null, canAccessDashboard: false });
    return c.redirect('/login');
  }

  const canAccessDashboard = user.role === 'admin' || isLocalHost(c.req.header('host'));
  c.set('userId', user.id);
  c.set('dashboardUser', user);
  c.set('canAccessDashboard', canAccessDashboard);
  c.set('shared', { user, canAccessDashboard });

  if (!canAccessDashboard && path !== '/') {
    return c.redirect('/');
  }

  return next();
});
