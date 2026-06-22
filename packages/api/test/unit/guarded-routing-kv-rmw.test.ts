import { describe, it, expect, vi } from 'vite-plus/test';
import { guardedRoutingKvRmw, type Db } from '../../src/db.ts';

/**
 * Minimal in-memory KV stub. `get` returns the raw string (or null), `put`
 * overwrites. Mirrors the slug/queue routing-entry shape used by the four F24
 * suspension sites and the F25 backfill.
 */
function createMockKV(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  } as unknown as KVNamespace & { store: Map<string, string> };
}

/**
 * Fake `Db` that runs `transaction(cb)` inline and serves the
 * `SELECT ... FOR UPDATE` issued by `lockProjectAndGetActiveDeploymentId`
 * (called via `tx.execute(...)`, reads `result.rows`). `onLock` fires the
 * instant the lock is taken — the parked-publisher seam, ordering a concurrent
 * publish BETWEEN the lock acquisition and the under-lock re-read+write.
 */
function createFakeDb(onLock?: () => void | Promise<void>): Db {
  const tx = {
    execute: async () => {
      if (onLock) {
        await onLock();
      }
      return { rows: [{ active_deployment_id: null }] };
    },
  };
  return {
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(tx),
  } as unknown as Db;
}

describe('guardedRoutingKvRmw', () => {
  it('no-ops when the key is absent', async () => {
    const kv = createMockKV();
    await guardedRoutingKvRmw(createFakeDb(), 'proj_a', kv, 'missing-slug', (entry) => {
      entry.suspended = 'x';
      return entry;
    });
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('skips the put when mutate returns null', async () => {
    const kv = createMockKV({ slug: JSON.stringify({ workerName: 'w' }) });
    await guardedRoutingKvRmw(createFakeDb(), 'proj_a', kv, 'slug', () => null);
    expect(kv.put).not.toHaveBeenCalled();
    expect(JSON.parse(kv.store.get('slug')!)).toEqual({ workerName: 'w' });
  });

  it('mutates and writes back the entry under the lock', async () => {
    const kv = createMockKV({ slug: JSON.stringify({ workerName: 'w', deploymentId: 'dpl_1' }) });
    await guardedRoutingKvRmw(createFakeDb(), 'proj_a', kv, 'slug', (entry) => {
      entry.suspended = 'requests_exceeded';
      return entry;
    });
    const next = JSON.parse(kv.store.get('slug')!);
    expect(next.suspended).toBe('requests_exceeded');
    expect(next.workerName).toBe('w');
    expect(next.deploymentId).toBe('dpl_1');
  });

  // F24 discriminator. A concurrent deploy publishes a NEWER slug route while
  // the suspend RMW holds the project lock (parked-publisher seam: the publish
  // is ordered AT lock-acquisition, i.e. between taking the lock and the
  // under-lock re-read). Because the helper re-reads UNDER the lock, `mutate`
  // runs on the FRESH (newer) value — the newer route SURVIVES and gains the
  // `suspended` marker.
  //
  // Without the fix the suspend reads + mutates + writes the slug WITHOUT a lock
  // or under-lock re-read: it stamps `suspended` on the value it read before the
  // publish landed and writes that stale entry back, clobbering the newer
  // deployment's route. (And since the newer active deployment is
  // `routing_published=true`, the hourly reconciler — which heals only
  // unpublished rows — never repairs the clobber.)
  it('stamps suspended on the FRESH route when a publish lands while the lock is held (F24)', async () => {
    const key = 'app-slug';
    const kv = createMockKV({
      [key]: JSON.stringify({ workerName: 'w', deploymentId: 'dpl_1', userId: 'u1' }),
    });

    // The publisher lands a newer deployment's route at lock-acquisition time.
    const db = createFakeDb(() => {
      kv.store.set(
        key,
        JSON.stringify({ workerName: 'w', deploymentId: 'dpl_2_NEWER', userId: 'u1' }),
      );
    });

    await guardedRoutingKvRmw(db, 'proj_a', kv, key, (entry) => {
      if (entry.suspended === 'requests_exceeded') {
        return null;
      }
      entry.suspended = 'requests_exceeded';
      return entry;
    });

    const survived = JSON.parse(kv.store.get(key)!);
    // The newer route survived...
    expect(survived.deploymentId).toBe('dpl_2_NEWER');
    // ...and gained the suspension marker (mutate ran on the fresh value).
    expect(survived.suspended).toBe('requests_exceeded');
  });
});
