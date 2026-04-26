import { Hono } from 'hono';
import { asRecord, asString } from './body';
import type { AiGateway, ProxyEnv } from './types';

const GATEWAY_ID = 'void';
const ALLOWED_GATEWAY_ENDPOINTS = new Set([
  'chat/completions',
  'images/generations',
  'images/edits',
]);
const VOID_FILE_MARKER = '__voidFile';

interface SerializedFileInput {
  [VOID_FILE_MARKER]: true;
  data: string;
  name?: string;
  type?: string;
}

class BadRequestError extends Error {}

const ai = new Hono<ProxyEnv>();

function hasStreamFlag(value: unknown): value is { stream?: boolean } {
  return typeof value === 'object' && value !== null && 'stream' in value;
}

function isBinaryView(value: unknown): value is ArrayBufferView {
  return ArrayBuffer.isView(value);
}

function isSerializedFileInput(value: unknown): value is SerializedFileInput {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[VOID_FILE_MARKER] === true &&
    typeof (value as Record<string, unknown>).data === 'string' &&
    ((value as Record<string, unknown>).name === undefined ||
      typeof (value as Record<string, unknown>).name === 'string') &&
    ((value as Record<string, unknown>).type === undefined ||
      typeof (value as Record<string, unknown>).type === 'string')
  );
}

function base64ToBytes(base64: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new BadRequestError('invalid file data');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function appendFormValue(form: FormData, key: string, value: unknown, requireFile = false): void {
  if (value === undefined) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      appendFormValue(form, key, item, requireFile);
    }
    return;
  }

  if (isSerializedFileInput(value)) {
    const blob = new Blob([base64ToBytes(value.data)], {
      type: value.type ?? 'application/octet-stream',
    });
    form.append(key, blob, value.name ?? key);
    return;
  }

  if (value instanceof Blob) {
    form.append(key, value, key);
    return;
  }

  if (requireFile) {
    throw new BadRequestError(`${key} must be a file`);
  }

  if (typeof value === 'object' && value !== null) {
    form.append(key, JSON.stringify(value));
    return;
  }

  form.append(key, String(value));
}

function imageEditForm(model: string, inputs: unknown): FormData {
  const form = new FormData();
  const rest = { ...asRecord(inputs) };
  delete rest.model;
  delete rest.stream;
  form.append('model', model);
  for (const [key, value] of Object.entries(rest)) {
    appendFormValue(form, key, value, key === 'image' || key === 'mask');
  }
  return form;
}

function gatewayQueryForEndpoint(endpoint: string, model: string, inputs: unknown): unknown {
  const { model: _model, stream, ...rest } = asRecord(inputs);

  const streamAsSse = endpoint === 'chat/completions' && stream === true;
  return {
    model,
    ...rest,
    ...(streamAsSse ? { stream: true } : {}),
  };
}

function gatewayEndpointUrl(baseUrl: string, endpoint: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  return `${normalizedBase}/${normalizedEndpoint}`;
}

async function runGatewayRequest({
  gateway,
  provider,
  endpoint,
  providerKey,
  projectId,
  query,
}: {
  gateway: AiGateway;
  provider: string;
  endpoint: string;
  providerKey: string;
  projectId: string;
  query: unknown;
}): Promise<Response> {
  const headers = {
    authorization: `Bearer ${providerKey}`,
    'cf-aig-metadata-projectId': projectId,
  };

  if (endpoint === 'images/edits') {
    const baseUrl = await gateway.getUrl(provider);
    return fetch(gatewayEndpointUrl(baseUrl, endpoint), {
      method: 'POST',
      headers,
      body: query as FormData,
    });
  }

  return gateway.run({
    provider,
    endpoint,
    headers,
    query,
  });
}

function headersForContentType(contentType: string | null | undefined): HeadersInit | undefined {
  return contentType ? { 'content-type': contentType } : undefined;
}

function filteredResponseHeaders(response: Response): Headers {
  const headers = new Headers();
  const contentType = response.headers.get('content-type');
  const cacheControl = response.headers.get('cache-control');
  if (contentType) {
    headers.set('content-type', contentType);
  }
  if (cacheControl) {
    headers.set('cache-control', cacheControl);
  }
  return headers;
}

function hasResponseMethod(value: unknown): value is { response(): Response | Promise<Response> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'response' in value &&
    typeof (value as { response?: unknown }).response === 'function'
  );
}

async function responseFromAiResult(result: unknown, streamAsSse: boolean): Promise<Response> {
  if (result instanceof Response) {
    return result;
  }

  if (hasResponseMethod(result)) {
    return result.response();
  }

  if (result instanceof ReadableStream) {
    return new Response(result, {
      headers: streamAsSse
        ? {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          }
        : { 'content-type': 'application/octet-stream' },
    });
  }

  if (result instanceof Blob) {
    return new Response(result, { headers: headersForContentType(result.type) });
  }

  if (result instanceof ArrayBuffer || isBinaryView(result)) {
    return new Response(result, { headers: { 'content-type': 'application/octet-stream' } });
  }

  return Response.json(result);
}

async function responseFromGateway(response: Response, streamAsSse: boolean): Promise<Response> {
  if (streamAsSse && response.body) {
    return new Response(response.body, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'access-control-allow-origin': '*',
      },
    });
  }

  return new Response(response.body, {
    status: response.status,
    headers: filteredResponseHeaders(response),
  });
}

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
    return responseFromAiResult(result, hasStreamFlag(body.inputs) && body.inputs.stream === true);
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
  const endpoint = asString(body.endpoint) ?? 'chat/completions';

  if (!modelPath) {
    return c.json({ error: 'model required' }, 400);
  }
  if (!providerKey) {
    return c.json({ error: 'providerKey required' }, 400);
  }
  if (!ALLOWED_GATEWAY_ENDPOINTS.has(endpoint)) {
    return c.json({ error: 'unsupported endpoint' }, 400);
  }

  // Parse "provider/model" format (e.g. "openai/gpt-4o")
  const slashIdx = modelPath.indexOf('/');
  if (slashIdx <= 0 || slashIdx === modelPath.length - 1) {
    return c.json({ error: 'model must use provider/model format' }, 400);
  }
  const provider = modelPath.slice(0, slashIdx);
  const model = modelPath.slice(slashIdx + 1);

  const { stream } = asRecord(body.inputs);
  const streamAsSse = endpoint === 'chat/completions' && stream === true;
  try {
    const gateway = c.env.AI.gateway(GATEWAY_ID);
    const query =
      endpoint === 'images/edits'
        ? imageEditForm(model, body.inputs)
        : gatewayQueryForEndpoint(endpoint, model, body.inputs);
    const response: Response = await runGatewayRequest({
      gateway,
      provider,
      endpoint,
      providerKey,
      projectId,
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

    return responseFromGateway(response, streamAsSse);
  } catch (err) {
    if (err instanceof BadRequestError) {
      return c.json({ error: err.message }, 400);
    }
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
