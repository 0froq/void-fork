import { Hono } from 'hono';
import type { ProxyEnv } from './types';

const app = new Hono<ProxyEnv>();

/**
 * Forward revalidation requests to the API via service binding.
 *
 * The auth middleware has already verified the HMAC token and set projectId.
 * We forward the token so the API can verify it independently.
 */
app.post('/', async (c) => {
  const projectId = c.get('projectId');
  const body = c.get('body');

  const response = await c.env.API.fetch(`https://api/internal/revalidate/${projectId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-void-internal': body.aiToken as string,
    },
    body: JSON.stringify({
      paths: body.paths,
      all: body.all,
    }),
  });

  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
});

export { app as revalidate };
