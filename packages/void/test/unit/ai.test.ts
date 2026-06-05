import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vite-plus/test';
import type { ai } from '../../src/runtime/ai.ts';

describe('runtime ai', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('routes Cloudflare provider models through the run endpoint unchanged', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { ai } = await import('../../src/runtime/ai.ts');

    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'Hi' } }] }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await envContext.run(
      {
        __VOID_TOKEN: 'void-token',
        __VOID_PROJECT_ID: 'proj_1',
        __VOID_PROXY_URL: 'https://proxy.test',
      },
      async () => {
        const result = await ai.run('google/gemini-2.5-flash', {
          messages: [{ role: 'user', content: 'Hello' }],
        });

        expect(result).toEqual({ choices: [{ message: { content: 'Hi' } }] });
      },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://proxy.test/ai/run');
    const init = fetchMock.mock.calls[0][1]!;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer void-token');
    expect(JSON.parse(init.body as string)).toEqual({
      action: 'run',
      model: 'google/gemini-2.5-flash',
      inputs: { messages: [{ role: 'user', content: 'Hello' }] },
      projectId: 'proj_1',
    });
  });

  it('routes provider-native JSON requests through the provider endpoint', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { ai } = await import('../../src/runtime/ai.ts');

    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: 'chatcmpl_1' }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await envContext.run(
      {
        __VOID_TOKEN: 'void-token',
        __VOID_PROJECT_ID: 'proj_1',
        __VOID_PROXY_URL: 'https://proxy.test',
        OPENAI_API_KEY: 'sk-test',
      },
      async () => {
        const response = await ai.provider('openai').fetch('/chat/completions', {
          headers: { 'openai-beta': 'assistants=v2' },
          body: {
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'Hello' }],
          },
        });

        expect(await response.json()).toEqual({ id: 'chatcmpl_1' });
      },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://proxy.test/ai/provider');
    const init = fetchMock.mock.calls[0][1]!;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer void-token');
    expect(JSON.parse(init.body as string)).toEqual({
      action: 'provider',
      provider: 'openai',
      path: '/chat/completions',
      headers: { 'openai-beta': 'assistants=v2' },
      body: {
        type: 'json',
        value: {
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Hello' }],
        },
      },
      providerKey: 'sk-test',
      projectId: 'proj_1',
    });
  });

  it('returns non-2xx provider responses for HTTP proxy requests', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { ai } = await import('../../src/runtime/ai.ts');

    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await envContext.run(
      {
        __VOID_TOKEN: 'void-token',
        __VOID_PROJECT_ID: 'proj_1',
        __VOID_PROXY_URL: 'https://proxy.test',
        OPENAI_API_KEY: 'sk-test',
      },
      async () => {
        const response = await ai.provider('openai').fetch('/chat/completions', {
          body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] },
        });

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: { message: 'Invalid API key' } });
      },
    );
  });

  it('returns non-2xx provider responses for service-binding proxy requests', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { ai } = await import('../../src/runtime/ai.ts');

    const proxyFetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );

    await envContext.run(
      {
        __VOID_PROXY: { fetch: proxyFetch },
        __PROJECT_ID: 'proj_1',
        __VOID_PROXY_TOKEN: 'proxy-token',
        OPENAI_API_KEY: 'sk-test',
      },
      async () => {
        const response = await ai.provider('openai').fetch('/chat/completions', {
          body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] },
        });

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: { message: 'Invalid API key' } });
      },
    );

    expect(proxyFetch).toHaveBeenCalledOnce();
    const init = proxyFetch.mock.calls[0][1]!;
    expect(JSON.parse(init.body as string)).toMatchObject({
      action: 'provider',
      provider: 'openai',
      path: '/chat/completions',
      providerKey: 'sk-test',
      projectId: 'proj_1',
      aiToken: 'proxy-token',
    });
  });

  it('supports provider API-key env and header overrides', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { ai } = await import('../../src/runtime/ai.ts');

    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok'),
    );
    vi.stubGlobal('fetch', fetchMock);

    await envContext.run(
      {
        __VOID_TOKEN: 'void-token',
        __VOID_PROJECT_ID: 'proj_1',
        __VOID_PROXY_URL: 'https://proxy.test',
        CUSTOM_AI_KEY: 'custom-key',
      },
      async () => {
        await ai
          .provider('custom-provider', {
            apiKeyEnv: 'CUSTOM_AI_KEY',
            apiKeyHeader: 'x-api-key',
            apiKeyPrefix: '',
          })
          .fetch('/v1/respond', { body: 'hello' });
      },
    );

    const init = fetchMock.mock.calls[0][1]!;
    expect(JSON.parse(init.body as string)).toEqual({
      action: 'provider',
      provider: 'custom-provider',
      path: '/v1/respond',
      body: { type: 'text', data: 'hello' },
      providerKey: 'custom-key',
      apiKeyHeader: 'x-api-key',
      apiKeyPrefix: '',
      projectId: 'proj_1',
    });
  });

  it('serializes provider-native multipart bodies', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { ai } = await import('../../src/runtime/ai.ts');

    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok'),
    );
    vi.stubGlobal('fetch', fetchMock);

    await envContext.run(
      {
        __VOID_TOKEN: 'void-token',
        __VOID_PROJECT_ID: 'proj_1',
        __VOID_PROXY_URL: 'https://proxy.test',
        OPENAI_API_KEY: 'sk-test',
      },
      async () => {
        const form = new FormData();
        form.set('model', 'gpt-image-1.5');
        form.set('prompt', 'change the background');
        form.set('image', new Blob(['png-bytes'], { type: 'image/png' }), 'source.png');

        await ai.provider('openai').fetch('/images/edits', { body: form });
      },
    );

    const init = fetchMock.mock.calls[0][1]!;
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      action: 'provider',
      provider: 'openai',
      path: '/images/edits',
      body: {
        type: 'form',
        entries: [
          { name: 'model', value: 'gpt-image-1.5' },
          { name: 'prompt', value: 'change the background' },
          {
            name: 'image',
            value: {
              __voidFile: true,
              data: 'cG5nLWJ5dGVz',
              name: 'source.png',
              type: 'image/png',
            },
          },
        ],
      },
      providerKey: 'sk-test',
      projectId: 'proj_1',
    });
  });

  it('types provider fetch calls', () => {
    type ProviderMethod = typeof ai.provider;
    const provider = undefined as unknown as ProviderMethod;

    const assertTypes = () => {
      provider('openai').fetch('/chat/completions', {
        body: {
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Hello' }],
        },
      });
      provider('custom', { apiKeyEnv: 'CUSTOM_AI_KEY' }).fetch('/v1/respond', {
        method: 'POST',
        headers: { 'x-test': '1' },
        body: new Uint8Array([1, 2]),
      });
    };

    expectTypeOf(assertTypes).toBeFunction();
    expectTypeOf(provider).toBeFunction();
  });

  it('returns blobs for non-JSON run responses', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw.ts');
    const { ai } = await import('../../src/runtime/ai.ts');

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('png-bytes', {
            headers: { 'content-type': 'image/png' },
          }),
      ),
    );

    await envContext.run(
      {
        __VOID_TOKEN: 'void-token',
        __VOID_PROJECT_ID: 'proj_1',
        __VOID_PROXY_URL: 'https://proxy.test',
      },
      async () => {
        const result = await ai.run(
          '@cf/black-forest-labs/flux-1-schnell' as keyof AiModels,
          {
            prompt: 'a small robot',
          } as never,
        );

        expect(result).toBeInstanceOf(Blob);
        expect((result as Blob).type).toBe('image/png');
        expect(await (result as Blob).text()).toBe('png-bytes');
      },
    );
  });
});
