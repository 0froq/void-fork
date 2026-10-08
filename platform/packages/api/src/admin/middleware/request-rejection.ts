import { browserPageLead, browserPageStatus } from '@void/platform/browser-page';
import type { Context } from 'hono';
import { platformBrowserPage } from '../../browser-page.ts';
import type { ApiEnv } from '../../env.ts';

export function adminAccessRejected(
  context: Context<ApiEnv>,
  reason: 'required' | 'suspended',
): Response {
  const suspended = reason === 'suspended';
  const title = suspended ? 'Administrator access suspended' : 'Administrator access required';
  const message = suspended
    ? 'Contact another platform administrator to restore access.'
    : 'Sign in with an administrator account for this platform.';
  return platformBrowserPage(
    context,
    title,
    browserPageStatus('error') +
      browserPageLead(title, message) +
      '<a class="void-auth-button void-auth-button-primary" href="/admin/logout">Sign in with another account</a>',
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
    return platformBrowserPage(
      context,
      'Request could not be verified',
      browserPageStatus('error') +
        browserPageLead('Request could not be verified', message) +
        '<a class="void-auth-button void-auth-button-primary" href="/admin/">Return to admin</a>',
      403,
    );
  }
  return format === 'json'
    ? context.json({ error, message }, 403)
    : context.text(`${error} ${message}`, 403);
}
