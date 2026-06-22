import { describe, it, expect, vi } from 'vite-plus/test';
import { backfillQueueTokens } from '../../src/admin/backfill-queue-tokens.ts';
import { hmacSignState } from '../../src/auth/hmac.ts';
import type { Db } from '../../src/db.ts';
import type { ProxyTokenLookup } from '../../src/provisioning/cloudflare-api.ts';

/**
 * Minimal fake `Db` that runs `transaction(cb)` inline and serves the
 * `SELECT ... FOR UPDATE` issued by `lockProjectAndGetActiveDeploymentId`
 * (which calls `tx.execute(...)` and reads `result.rows`). `onLock` lets a
 * test inject a side effect (e.g. a concurrent publish) at the moment the
 * lock is taken — modelling the parked-publisher seam.
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

function createMockKV(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (key: string, type?: 'json' | 'text') => {
      const raw = store.get(key);
      if (raw == null) {
        return null;
      }
      if (type === 'json') {
        return JSON.parse(raw);
      }
      return raw;
    }),
    put: vi.fn(async (key: string, value: string | ArrayBuffer) => {
      store.set(key, typeof value === 'string' ? value : new TextDecoder().decode(value));
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix, cursor }: { prefix?: string; cursor?: string } = {}) => {
      const all = Array.from(store.keys())
        .filter((k) => !prefix || k.startsWith(prefix))
        .sort();
      const start = cursor ? all.indexOf(cursor) + 1 : 0;
      const page = all.slice(start, start + 2);
      const last = all.indexOf(page[page.length - 1] ?? '');
      const hasMore = last >= 0 && last < all.length - 1;
      return {
        keys: page.map((name) => ({ name })),
        list_complete: !hasMore,
        ...(hasMore ? { cursor: page[page.length - 1] } : {}),
      };
    }),
  } as unknown as KVNamespace & { store: Map<string, string> };
}

const JWT_SECRET = 'test-jwt-secret';
const ACCOUNT = 'acc_test';
const TOKEN = 'token_test';
const NAMESPACE = 'void-users';

type FetchTokenOptions = {
  fetchToken?: (workerName: string) => Promise<ProxyTokenLookup>;
};

function makeOpts(overrides: FetchTokenOptions = {}) {
  return {
    accountId: ACCOUNT,
    apiToken: TOKEN,
    dispatchNamespace: NAMESPACE,
    jwtSecret: JWT_SECRET,
    fetchToken:
      overrides.fetchToken ??
      (async (workerName: string): Promise<ProxyTokenLookup> => ({
        kind: 'found',
        token: `baked-token-for-${workerName}`,
      })),
  };
}

describe('backfillQueueTokens', () => {
  it('stamps the token fetched from the worker bindings, not a re-derived one', async () => {
    const kv = createMockKV({
      'queue:proj-a-emails': JSON.stringify({
        workerName: 'user-a-dpl_1',
        projectId: 'proj_a',
        queueName: 'emails',
      }),
    });

    const result = await backfillQueueTokens(kv, createFakeDb(), makeOpts());

    expect(result).toEqual({
      scanned: 1,
      updated: 1,
      skipped: 0,
      raced: 0,
      errored: 0,
      skippedLegacy: 0,
    });
    const patched = JSON.parse(kv.store.get('queue:proj-a-emails')!);
    expect(patched.proxyToken).toBe('baked-token-for-user-a-dpl_1');
  });

  it('falls back to hmacSignState re-derivation when the worker has no baked token', async () => {
    const kv = createMockKV({
      'queue:proj-legacy-emails': JSON.stringify({
        workerName: 'user-legacy',
        projectId: 'proj_legacy',
        queueName: 'emails',
      }),
    });

    const result = await backfillQueueTokens(
      kv,
      createFakeDb(),
      makeOpts({ fetchToken: async () => ({ kind: 'missing' }) }),
    );

    expect(result).toEqual({
      scanned: 1,
      updated: 1,
      skipped: 0,
      raced: 0,
      errored: 0,
      skippedLegacy: 0,
    });
    const expected = await hmacSignState('proj_legacy', JWT_SECRET);
    const patched = JSON.parse(kv.store.get('queue:proj-legacy-emails')!);
    expect(patched.proxyToken).toBe(expected);
  });

  it('skips entries that already have a proxyToken', async () => {
    const kv = createMockKV({
      'queue:proj-a-emails': JSON.stringify({
        workerName: 'user-a',
        projectId: 'proj_a',
        queueName: 'emails',
        proxyToken: 'already-set',
      }),
    });

    const result = await backfillQueueTokens(kv, createFakeDb(), makeOpts());

    expect(result).toEqual({
      scanned: 1,
      updated: 0,
      skipped: 1,
      raced: 0,
      errored: 0,
      skippedLegacy: 0,
    });
    const patched = JSON.parse(kv.store.get('queue:proj-a-emails')!);
    expect(patched.proxyToken).toBe('already-set');
  });

  it('counts entries as `errored` and does not overwrite when the CF binding read fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const original = JSON.stringify({
        workerName: 'user-rate-limited',
        projectId: 'proj_rl',
        queueName: 'emails',
      });
      const kv = createMockKV({ 'queue:proj-rl-emails': original });

      const result = await backfillQueueTokens(
        kv,
        createFakeDb(),
        makeOpts({
          fetchToken: async () => ({
            kind: 'error',
            error: new Error('CF 429 rate limit'),
          }),
        }),
      );

      expect(result).toEqual({
        scanned: 1,
        updated: 0,
        skipped: 0,
        raced: 0,
        errored: 1,
        skippedLegacy: 0,
      });
      // Value must be untouched — writing a re-derived token on a transient
      // CF failure would permanently mask the incident as a successful migration.
      expect(kv.store.get('queue:proj-rl-emails')).toBe(original);
      expect(errSpy).toHaveBeenCalled();
      const logged = errSpy.mock.calls
        .flat()
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      expect(logged).toMatch(/CF 429 rate limit/);
      expect(logged).toMatch(/user-rate-limited/);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('paginates across multiple KV list pages', async () => {
    const kv = createMockKV({
      'queue:proj-a-q1': JSON.stringify({
        workerName: 'user-a',
        projectId: 'proj_a',
        queueName: 'q1',
      }),
      'queue:proj-a-q2': JSON.stringify({
        workerName: 'user-a',
        projectId: 'proj_a',
        queueName: 'q2',
      }),
      'queue:proj-b-q1': JSON.stringify({
        workerName: 'user-b',
        projectId: 'proj_b',
        queueName: 'q1',
      }),
    });

    const result = await backfillQueueTokens(kv, createFakeDb(), makeOpts());

    expect(result).toEqual({
      scanned: 3,
      updated: 3,
      skipped: 0,
      raced: 0,
      errored: 0,
      skippedLegacy: 0,
    });
    expect(kv.list).toHaveBeenCalledTimes(2);
  });

  it('does not touch non-queue: keys', async () => {
    const kv = createMockKV({
      'queue:proj-a-q1': JSON.stringify({
        workerName: 'user-a',
        projectId: 'proj_a',
        queueName: 'q1',
      }),
      'proj-a': JSON.stringify({ workerName: 'a' }),
      'domain:example.com': JSON.stringify({ workerName: 'a' }),
    });

    const result = await backfillQueueTokens(kv, createFakeDb(), makeOpts());

    expect(result.scanned).toBe(1);
    expect(result.updated).toBe(1);
    expect(JSON.parse(kv.store.get('proj-a')!)).toEqual({ workerName: 'a' });
    expect(JSON.parse(kv.store.get('domain:example.com')!)).toEqual({ workerName: 'a' });
  });

  it('skips entries with missing workerName (cannot resolve token)', async () => {
    const kv = createMockKV({
      'queue:bogus': JSON.stringify({ projectId: 'proj_x', queueName: 'emails' }),
    });

    const result = await backfillQueueTokens(kv, createFakeDb(), makeOpts());

    expect(result).toEqual({
      scanned: 1,
      updated: 0,
      skipped: 1,
      raced: 0,
      errored: 0,
      skippedLegacy: 0,
    });
    expect(JSON.parse(kv.store.get('queue:bogus')!)).toEqual({
      projectId: 'proj_x',
      queueName: 'emails',
    });
  });

  it('detects concurrent writes and skips the put to avoid clobbering', async () => {
    const kv = createMockKV({
      'queue:proj-a-emails': JSON.stringify({
        workerName: 'user-a-dpl_1',
        projectId: 'proj_a',
        queueName: 'emails',
      }),
    });

    // Simulate a concurrent deploy that writes a new entry between our
    // initial read and our final put. The backfill must re-read before
    // writing and skip if the snapshot no longer matches.
    let getCalls = 0;
    const originalGet = kv.get.bind(kv) as (
      key: string,
      type?: 'json' | 'text',
    ) => Promise<string | null>;
    kv.get = vi.fn(async (key: string, type?: 'json' | 'text') => {
      getCalls++;
      if (getCalls === 2 && key === 'queue:proj-a-emails') {
        // Second read (our re-check right before put) sees a mutated value.
        kv.store.set(
          key,
          JSON.stringify({
            workerName: 'user-a-dpl_2',
            projectId: 'proj_a',
            queueName: 'emails',
            proxyToken: 'written-by-concurrent-deploy',
          }),
        );
      }
      return originalGet(key, type);
    }) as unknown as KVNamespace['get'];

    const result = await backfillQueueTokens(kv, createFakeDb(), makeOpts());

    expect(result).toEqual({
      scanned: 1,
      updated: 0,
      skipped: 0,
      raced: 1,
      errored: 0,
      skippedLegacy: 0,
    });
    // The concurrent writer's value must survive — backfill must not overwrite.
    const patched = JSON.parse(kv.store.get('queue:proj-a-emails')!);
    expect(patched.workerName).toBe('user-a-dpl_2');
    expect(patched.proxyToken).toBe('written-by-concurrent-deploy');
  });

  // F25 discriminator: a concurrent deploy publishes a NEWER queue route while
  // the backfill holds the project lock (the parked-publisher seam: the publish
  // is ordered AT lock-acquisition, i.e. between the snapshot read and the
  // under-lock re-read+put). The lock-guarded RMW re-reads UNDER the lock, sees
  // the newer value, and SKIPS the put — so the deploy's route survives.
  //
  // Without the fix the put is lock-free: there is no under-lock re-read, so the
  // backfill clobbers the deploy's newer route with the stale snapshot + token.
  it('does not clobber a concurrent publish that lands while the project lock is held (projectId entry)', async () => {
    const key = 'queue:proj-a-emails';
    const kv = createMockKV({
      [key]: JSON.stringify({
        workerName: 'user-a-dpl_1',
        projectId: 'proj_a',
        queueName: 'emails',
      }),
    });

    // The publisher fires exactly when the backfill takes the FOR UPDATE lock,
    // landing a newer deployment's route. With the lock-guarded re-read this is
    // observed and the put is skipped; a lock-free path would overwrite it.
    const db = createFakeDb(() => {
      kv.store.set(
        key,
        JSON.stringify({
          workerName: 'user-a-dpl_2',
          projectId: 'proj_a',
          queueName: 'emails',
          proxyToken: 'written-by-concurrent-deploy',
        }),
      );
    });

    const result = await backfillQueueTokens(kv, db, makeOpts());

    expect(result).toEqual({
      scanned: 1,
      updated: 0,
      skipped: 0,
      raced: 1,
      errored: 0,
      skippedLegacy: 0,
    });
    const survived = JSON.parse(kv.store.get(key)!);
    expect(survived.workerName).toBe('user-a-dpl_2');
    expect(survived.proxyToken).toBe('written-by-concurrent-deploy');
  });

  // F29 discriminator: a legacy queue entry WITHOUT a projectId has no lockable
  // project, so the backfill cannot serialize against a concurrent publisher. It
  // must SKIP the write entirely (reported in `skippedLegacy`, logged with a
  // running count) so a concurrent publish to that key is never clobbered.
  //
  // Without the fix the no-projectId path did a lock-free re-read-then-put: a
  // publish landing in the TOCTOU window BETWEEN the re-read and the put would be
  // clobbered with the stale snapshot + token — permanently, since the newer
  // active deployment is `routing_published=true` and the reconciler heals only
  // unpublished rows. The seam fires the concurrent publish ON the `put` call
  // (just before the bytes land), modelling exactly that window:
  //   - pre-fix: the path reaches `put`, the seam lands the newer route, then the
  //     stale put OVERWRITES it (clobber) and reports `updated`.
  //   - post-fix: the legacy entry is SKIPPED before any put, so the publish's
  //     route survives and the entry is counted as `skippedLegacy`.
  it('SKIPS a no-projectId legacy entry and never clobbers a concurrent publish to that key', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const key = 'queue:legacy-no-project';
      const snapshot = JSON.stringify({
        workerName: 'user-legacy-dpl_1',
        queueName: 'emails',
      });
      const kv = createMockKV({ [key]: snapshot });

      // Fire the concurrent publish the instant the backfill calls `put(key, …)`
      // — i.e. AFTER any lock-free re-read passed, in the window the pre-fix path
      // is blind to. The publish lands the newer route, then the (pre-fix) put
      // overwrites it. The post-fix path never calls `put` for this key, so this
      // never runs and the publish survives.
      const originalPut = kv.put.bind(kv) as (k: string, v: string) => Promise<void>;
      kv.put = vi.fn(async (k: string, v: string | ArrayBuffer) => {
        if (k === key) {
          kv.store.set(
            key,
            JSON.stringify({
              workerName: 'user-legacy-dpl_2',
              queueName: 'emails',
              proxyToken: 'written-by-concurrent-deploy',
            }),
          );
        }
        return originalPut(k, typeof v === 'string' ? v : new TextDecoder().decode(v));
      }) as unknown as KVNamespace['put'];

      const result = await backfillQueueTokens(kv, createFakeDb(), makeOpts());

      // The entry is skipped as legacy — not updated, not raced.
      expect(result).toEqual({
        scanned: 1,
        updated: 0,
        skipped: 0,
        raced: 0,
        errored: 0,
        skippedLegacy: 1,
      });
      // The load-bearing discriminator: post-fix there is NO put for this key,
      // so the backfill cannot clobber whatever a concurrent publisher writes.
      // Pre-fix the lock-free path DID put (the seam then clobbers), so this
      // assertion + `skippedLegacy: 1` both fail without the fix.
      expect(kv.put).not.toHaveBeenCalledWith(key, expect.anything());
      const survived = JSON.parse(kv.store.get(key)!);
      expect(survived.proxyToken).toBeUndefined();
      // A running-count warning is logged for the skipped legacy entry.
      expect(warnSpy).toHaveBeenCalled();
      const logged = warnSpy.mock.calls
        .flat()
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      expect(logged).toMatch(/skippedLegacy=1/);
      expect(logged).toMatch(/queue:legacy-no-project/);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
