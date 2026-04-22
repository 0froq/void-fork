import { Hono } from 'hono';
import { asRecord, asString } from './body';
import type { ProxyEnv } from './types';

const GATEWAY_ID = 'void';

const ai = new Hono<ProxyEnv>();

ai.post('/run', async (c) => {
  const body = c.get('body');
  const projectId = c.get('projectId');
  const model = asString(body.model);

  if (!model) {
    return c.json({ error: 'model required' }, 400);
  }

  const options = {
    ...asRecord(body.options),
    gateway: { id: GATEWAY_ID, metadata: { projectId } },
  };

  try {
    const result = await c.env.AI.run(model, body.inputs, options);

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
  const modelPath = asString(body.model);
  const providerKey = asString(body.providerKey);

  if (!modelPath) {
    return c.json({ error: 'model required' }, 400);
  }
  if (!providerKey) {
    return c.json({ error: 'providerKey required' }, 400);
  }

  // Parse "provider/model" format (e.g. "openai/gpt-4o")
  const slashIdx = modelPath.indexOf('/');
  const provider = modelPath.slice(0, slashIdx);
  const model = modelPath.slice(slashIdx + 1);

  const { stream, ...rest } = asRecord(body.inputs);
  const query: Record<string, unknown> = {
    model,
    ...rest,
    ...(stream ? { stream: true } : {}),
  };

  try {
    const gateway = c.env.AI.gateway(GATEWAY_ID);
    const response: Response = await gateway.run({
      provider,
      endpoint: 'chat/completions',
      headers: {
        authorization: `Bearer ${providerKey}`,
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
    const result = await c.env.AI.models(body.inputs);
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
    const result = await c.env.AI.toMarkdown(body.inputs, body.options);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('AI inference error:', message);
    return c.json({ error: 'inference error' }, 502);
  }
});

export { ai };
