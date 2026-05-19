import { describe, expect, it, vi } from 'vite-plus/test';
import {
  buildProjectAccountJson,
  buildRoutingJson,
  buildStaticRoutingJson,
  projectAccountKey,
  refreshProjectKvForUser,
} from '../../src/routing.ts';

describe('buildRoutingJson', () => {
  const base = {
    workerName: 'user-app',
    projectId: 'proj_1',
    userId: 'user_1',
    manifest: null,
    deploymentId: 'dep_1',
    dispatchLimits: null,
  };

  it('omits assetManifestId and assetConfig when not provided', () => {
    const parsed = JSON.parse(buildRoutingJson(base));
    expect(parsed.assetManifestId).toBeUndefined();
    expect(parsed.assetConfig).toBeUndefined();
  });

  it('emits assetManifestId when provided', () => {
    const parsed = JSON.parse(buildRoutingJson({ ...base, assetManifestId: 'dep_1' }));
    expect(parsed.assetManifestId).toBe('dep_1');
  });

  it('emits assetConfig when provided', () => {
    const parsed = JSON.parse(
      buildRoutingJson({
        ...base,
        assetManifestId: 'dep_1',
        assetConfig: { not_found_handling: 'none' },
      }),
    );
    expect(parsed.assetConfig).toEqual({ not_found_handling: 'none' });
  });

  it('keeps staticDeploymentId absent (WfP entries must not be misclassified)', () => {
    const parsed = JSON.parse(
      buildRoutingJson({
        ...base,
        assetManifestId: 'dep_1',
        assetConfig: { not_found_handling: 'none' },
      }),
    );
    expect(parsed.staticDeploymentId).toBeUndefined();
  });
});

describe('buildStaticRoutingJson', () => {
  it('still emits staticDeploymentId (unchanged behavior)', () => {
    const parsed = JSON.parse(
      buildStaticRoutingJson({
        projectId: 'proj_1',
        userId: 'user_1',
        deploymentId: 'dep_1',
        assetConfig: { not_found_handling: 'single-page-application' },
        manifest: null,
      }),
    );
    expect(parsed.staticDeploymentId).toBe('dep_1');
    expect(parsed.assetConfig).toEqual({ not_found_handling: 'single-page-application' });
    expect(parsed.assetManifestId).toBeUndefined();
  });
});

describe('projectAccountKey', () => {
  it('namespaces the project id under the `project:` prefix the proxy reads', () => {
    expect(projectAccountKey('proj_1')).toBe('project:proj_1');
  });
});

describe('buildProjectAccountJson', () => {
  it('emits camelCase `userId` and `plan` so packages/proxy/src/sandbox.ts can parse it', () => {
    expect(buildProjectAccountJson({ userId: 'user_1', plan: 'pro' })).toBe(
      JSON.stringify({ userId: 'user_1', plan: 'pro' }),
    );
  });
});

describe('refreshProjectKvForUser', () => {
  function createKv(): { puts: Array<[string, string]>; kv: KVNamespace } {
    const puts: Array<[string, string]> = [];
    const kv = {
      put: async (key: string, value: string) => {
        puts.push([key, value]);
      },
    } as unknown as KVNamespace;
    return { puts, kv };
  }

  it('rewrites a project entry per project the user owns', async () => {
    const { puts, kv } = createKv();
    const db = {} as Parameters<typeof refreshProjectKvForUser>[0];
    vi.spyOn(await import('../../src/db.ts'), 'getUser').mockResolvedValue({
      id: 'user_1',
      plan: 'pro',
    } as Awaited<ReturnType<typeof import('../../src/db.ts').getUser>>);
    vi.spyOn(await import('../../src/db.ts'), 'getProjectsByUserId').mockResolvedValue([
      { id: 'proj_a' },
      { id: 'proj_b' },
    ] as unknown as Awaited<ReturnType<typeof import('../../src/db.ts').getProjectsByUserId>>);

    await refreshProjectKvForUser(db, kv, 'user_1');

    expect(puts).toHaveLength(2);
    const keys = puts.map(([k]) => k).sort();
    expect(keys).toEqual(['project:proj_a', 'project:proj_b']);
    for (const [, value] of puts) {
      expect(JSON.parse(value)).toEqual({ userId: 'user_1', plan: 'pro' });
    }
    vi.restoreAllMocks();
  });

  it('no-ops when the user is missing (treats deletion as nothing to refresh)', async () => {
    const { puts, kv } = createKv();
    const db = {} as Parameters<typeof refreshProjectKvForUser>[0];
    vi.spyOn(await import('../../src/db.ts'), 'getUser').mockResolvedValue(null);
    await refreshProjectKvForUser(db, kv, 'ghost');
    expect(puts).toEqual([]);
    vi.restoreAllMocks();
  });

  it('no-ops when the user owns zero projects (avoids a wasted KV roundtrip)', async () => {
    const { puts, kv } = createKv();
    const db = {} as Parameters<typeof refreshProjectKvForUser>[0];
    vi.spyOn(await import('../../src/db.ts'), 'getUser').mockResolvedValue({
      id: 'user_1',
      plan: 'free',
    } as Awaited<ReturnType<typeof import('../../src/db.ts').getUser>>);
    vi.spyOn(await import('../../src/db.ts'), 'getProjectsByUserId').mockResolvedValue([]);
    await refreshProjectKvForUser(db, kv, 'user_1');
    expect(puts).toEqual([]);
    vi.restoreAllMocks();
  });
});
