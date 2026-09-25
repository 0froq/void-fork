import { renderReactPage } from '@void/react/pages-server';
import type { Context } from 'hono';
import type { PageObject } from 'void/pages-protocol';
import adminClientScript from 'void:admin-client-script';
import type { ApiEnv } from '../../env.ts';
import { formatPlatformPageTitle } from '../../platform-identity.ts';
import { adminComponents, type AdminPageId } from './pages.ts';
import { ADMIN_CSS } from './views/layout.tsx';

export function serveAdminClient(): Response {
  return new Response(adminClientScript, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function renderAdminPage(
  context: Context<ApiEnv>,
  component: AdminPageId,
  title: string,
  props: Record<string, unknown>,
  options: { status?: number; css?: boolean } = {},
): Promise<Response> {
  const platformName = String(props.platformName ?? 'Void');
  const pageObj: PageObject = {
    component,
    props,
    params: {},
    shared: {},
    url: new URL(context.req.url).pathname + new URL(context.req.url).search,
    errors: null,
    head: {
      title: formatPlatformPageTitle(title, platformName),
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ],
    },
  };
  const headers = {
    'Cache-Control': 'private, no-store',
    Vary: 'X-VoidPages',
    'X-VoidPages': 'true',
  };
  if (context.req.header('X-VoidPages') === 'true') {
    return Response.json(pageObj, { headers, status: options.status ?? 200 });
  }
  const stream = await renderReactPage({
    pageObj,
    components: adminComponents,
    layoutTree: {},
    assetTags: {
      css: options.css === false ? '' : `<style>${ADMIN_CSS}</style>`,
      preloads: '',
      body: '<script src="/admin/client.js" defer></script>',
    },
  });
  return new Response(stream, {
    status: options.status ?? 200,
    headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
  });
}
