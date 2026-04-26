import { afterEach, describe, expect, it, vi } from 'vitest';

describe('runtime ai', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('routes third-party image generation through the gateway endpoint', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw');
    const { ai } = await import('../../src/runtime/ai');

    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Response(JSON.stringify({ data: [{ b64_json: 'abc123' }] }), {
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
        const response = await ai.image('openai/gpt-image-1.5', {
          prompt: 'a small robot',
          size: '1024x1024',
        });

        expect(await response.json()).toEqual({ data: [{ b64_json: 'abc123' }] });
      },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://proxy.test/ai/gateway');
    const init = fetchMock.mock.calls[0][1]!;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer void-token');
    expect(JSON.parse(init.body as string)).toEqual({
      action: 'gateway',
      endpoint: 'images/generations',
      model: 'openai/gpt-image-1.5',
      inputs: { prompt: 'a small robot', size: '1024x1024' },
      providerKey: 'sk-test',
      projectId: 'proj_1',
    });
  });

  it('returns blobs for non-JSON run responses', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env-raw');
    const { ai } = await import('../../src/runtime/ai');

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
