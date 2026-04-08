import { Hono } from 'hono';
import type { ProxyEnv } from './types';

const GATEWAY_ID = 'void';

const ai = new Hono<ProxyEnv>();

ai.post('/run', async (c) => {
  const body = c.get('body');
  const projectId = c.get('projectId');

  if (!body.model) {
    return c.json({ error: 'model required' }, 400);
  }

  const options = {
    ...(body.options ?? {}),
    gateway: { id: GATEWAY_ID, metadata: { projectId } },
  };

  try {
    const result = await (c.env.AI as any).run(body.model, body.inputs, options);

    if (result instanceof ReadableStream) {
      return new Response(result, {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
      });
    }
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('AI inference error:', message);
    return c.json({ error: 'inference error' }, 502);
  }
});

ai.post('/gateway', async (c) => {
  const body = c.get('body');
  const projectId = c.get('projectId');

  if (!body.model) {
    return c.json({ error: 'model required' }, 400);
  }
  if (!body.providerKey) {
    return c.json({ error: 'providerKey required' }, 400);
  }

  // Parse "provider/model" format (e.g. "openai/gpt-4o")
  const slashIdx = (body.model as string).indexOf('/');
  const provider = (body.model as string).slice(0, slashIdx);
  const model = (body.model as string).slice(slashIdx + 1);

  const { stream, ...rest } = (body.inputs ?? {}) as Record<string, unknown>;
  const query: Record<string, unknown> = {
    model,
    ...rest,
    ...(stream ? { stream: true } : {}),
  };

  try {
    const gateway = (c.env.AI as any).gateway(GATEWAY_ID);
    const response: Response = await gateway.run({
      provider,
      endpoint: 'chat/completions',
      headers: {
        authorization: `Bearer ${body.providerKey}`,
        'cf-aig-metadata-projectId': projectId,
      },
      query,
    });

    if (!response.ok) {
      const text = await response.text();
      let error: string;
      try {
        const json = JSON.parse(text);
        error = json.error?.message ?? text;
      } catch {
        error = text;
      }
      return c.json({ error }, response.status as 400);
    }

    if (stream && response.body) {
      return new Response(response.body, {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'access-control-allow-origin': '*',
        },
      });
    }

    const result = await response.json();
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('AI Gateway error:', message);
    return c.json({ error: 'gateway error' }, 502);
  }
});

ai.post('/models', async (c) => {
  const body = c.get('body');
  try {
    const result = await (c.env.AI as any).models(body.inputs);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('AI inference error:', message);
    return c.json({ error: 'inference error' }, 502);
  }
});

ai.post('/toMarkdown', async (c) => {
  const body = c.get('body');
  try {
    const result = await (c.env.AI as any).toMarkdown(body.inputs, body.options);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('AI inference error:', message);
    return c.json({ error: 'inference error' }, 502);
  }
});

export { ai };
