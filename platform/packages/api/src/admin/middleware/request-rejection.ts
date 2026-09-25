import type { Context } from 'hono';
import { escapeHtml } from '../../email.ts';
import type { ApiEnv } from '../../env.ts';
import { getPlatformPageTitle } from '../../platform-identity.ts';

function errorTitle(context: Context<ApiEnv>, page: string): string {
  return `<title>${escapeHtml(getPlatformPageTitle(page, context.env, context.req.url))}</title>`;
}

export function adminAccessRejected(
  context: Context<ApiEnv>,
  reason: 'required' | 'suspended',
): Response {
  if (reason === 'suspended') {
    return context.html(
      errorTitle(context, 'Administrator access suspended') +
        '<h1>Administrator access suspended</h1><p>Contact another platform administrator to restore access.</p><p><a href="/admin/logout">Sign in with another account</a></p>',
      403,
    );
  }
  return context.html(
    errorTitle(context, 'Administrator access required') +
      '<h1>Administrator access required</h1><p>Sign in with an administrator account for this platform.</p><p><a href="/admin/logout">Sign in with another account</a></p>',
    403,
  );
}

export function adminRequestRejected(
  context: Context<ApiEnv>,
  error: string,
  format: 'json' | 'text',
): Response {
  const message = 'Return to the admin page, refresh it, and try again.';
  if (context.req.header('Accept')?.includes('text/html')) {
    return context.html(
      errorTitle(context, 'Request could not be verified') +
        '<h1>Request could not be verified</h1><p>Return to the admin page, refresh it, and try again.</p><p><a href="/admin/">Return to admin</a></p>',
      403,
    );
  }
  return format === 'json'
    ? context.json({ error, message }, 403)
    : context.text(`${error} ${message}`, 403);
}
