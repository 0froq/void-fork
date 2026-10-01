import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PlatformClient } from '../../src/cli/client.ts';

const fetchMock = vi.fn();
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as typeof globalThis.fetch;
  fetchMock.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function client(): PlatformClient {
  return new PlatformClient('test-token', { apiUrl: 'https://api.example.test' });
}

const project = { id: 'proj_1', slug: 'my-app', role: 'collaborator' };

describe('targeted project lookup', () => {
  it('lists interactive choices without requesting deployment and traffic summaries', async () => {
    fetchMock.mockResolvedValueOnce(Response.json([project]));
    await expect(client().listProjectChoices()).resolves.toEqual([project]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.example.test/projects/choices',
    ]);
  });

  it('resolves a slug without loading the project list', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ project }));

    await expect(client().findProjectBySlug('my app')).resolves.toEqual(project);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.example.test/projects/resolve?slug=my+app',
    );
  });

  it('distinguishes a missing project from an older platform', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ project: null }));
    await expect(client().findProjectBySlug('missing')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(['listProjectChoices', 'findProjectBySlug'] as const)(
    'requires an upgrade when %s is unsupported',
    async (method) => {
      fetchMock.mockResolvedValueOnce(Response.json({ error: 'not found' }, { status: 404 }));
      const api = client();
      await expect(
        method === 'findProjectBySlug' ? api.findProjectBySlug('my-app') : api.listProjectChoices(),
      ).rejects.toThrow('Ask its administrator to upgrade the platform runtime.');
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).not.toBe('https://api.example.test/projects');
    },
  );

  it('loads a linked project by ID and treats 404 as unavailable', async () => {
    fetchMock.mockResolvedValueOnce(Response.json(project));
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'not found' }, { status: 404 }));

    const api = client();
    await expect(api.getProject('proj_1')).resolves.toEqual(project);
    await expect(api.getProject('missing')).resolves.toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.example.test/projects/proj_1',
      'https://api.example.test/projects/missing',
    ]);
  });
});
