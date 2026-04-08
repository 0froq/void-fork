import { deleteCookie } from 'hono/cookie';
import { defineHandler } from 'void';

export const loader = defineHandler((c) => {
  deleteCookie(c, 'void_token', { path: '/' });
  return c.redirect('/login');
});
