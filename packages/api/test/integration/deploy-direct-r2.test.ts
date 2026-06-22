/**
 * Integration tests for the direct-to-R2 asset upload deploy flow
 * (`meta/design-docs/0068-direct-r2-asset-upload.md`).
 *
 * Two endpoints are exercised:
 *   - `POST /:id/deploy/upload-urls` — issues presigned R2 PUT URLs for
 *     declared assets.
 *   - `POST /:id/deploy` (Content-Type: application/json) — manifest-only
 *     deploy whose asset bytes are already in R2 from prior direct PUTs.
 */
import { eq, sql } from 'drizzle-orm';
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from 'vite-plus/test';
import { computeAssetHash } from '../../src/assets.ts';
import { cancelDeployment } from '../../src/db.ts';
import * as db from '../../src/db.ts';
import app from '../../src/index.ts';
import { getProjectQueueName } from '../../src/naming.ts';
import { deployments, domains, projects } from '../../src/schema.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  mockCfApi,
  cfSuccess,
  readAllEvents,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Synthetic 32-hex blake3 / md5 strings. Real hashes round-trip through the
// presigner unchanged; the deploy pipeline only validates shape (32 hex)
// and looks up bytes by `assets/${projectId}/${blake3}`. Tests put the
// bytes into our R2 mock at that exact key — no real BLAKE3 needed.
const HASH = (n: number): string => n.toString(16).padStart(32, '0');
const MD5 = HASH;

/**
 * Pre-stage asset bytes in R2 under the direct-to-R2 storage key. Mirrors
 * what the CLI does after receiving presigned URLs from
 * `POST /deploy/upload-urls`.
 */
async function stageAssetInR2(
  bucket: R2Bucket,
  projectId: string,
  blake3: string,
  bytes: Uint8Array,
): Promise<void> {
  await bucket.put(
    `assets/${projectId}/${blake3}`,
    // R2's `put` accepts ArrayBuffer.
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
}

type DeployEventBase = {
  event: string;
};
function isEvent(v: unknown, name: string): v is DeployEventBase {
  return typeof v === 'object' && v !== null && (v as DeployEventBase).event === name;
}

describe('POST /projects/:id/deploy/upload-urls', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/projects/proj_x/deploy/upload-urls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assets: [] }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 for nonexistent project', async () => {
    const user = await createTestUser(env.db);
    const res = await app.fetch(
      new Request('http://localhost/projects/proj_missing/deploy/upload-urls', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ assets: [] }),
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 for foreign project', async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    const project = await createTestProject(env.db, alice.id, 'alice-app-uu');
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy/upload-urls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bob.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ assets: [] }),
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('issues presigned URLs for valid asset entries', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'uu-happy');
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy/upload-urls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
          'X-Void-CLI-Version': '0.8.3',
        },
        body: JSON.stringify({
          assets: [
            { blake3: HASH(1), md5: MD5(2), size: 10, contentType: 'text/html' },
            { blake3: HASH(3), md5: MD5(4), size: 20, contentType: 'application/javascript' },
          ],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      urls: Record<string, { url: string; headers: Record<string, string> }>;
    };
    expect(Object.keys(body.urls)).toEqual(expect.arrayContaining([HASH(1), HASH(3)]));
    const first = body.urls[HASH(1)];
    expect(first).toBeDefined();
    expect(first.url).toContain(`/${env.R2_STATIC_ASSETS_BUCKET}/assets/${project.id}/${HASH(1)}`);
    expect(first.headers['Content-Md5']).toBeDefined();
    expect(first.headers['Content-Type']).toBe('text/html');
    // TTL: 30 minutes. Bumped from 10 min to cover slow tail uploads
    // (large bundle × low concurrency × residential uplink). Both URLs in
    // the batch must carry the same expiry — they're issued in parallel
    // off the same handler invocation.
    const url1 = new URL(first.url);
    expect(url1.searchParams.get('X-Amz-Expires')).toBe('1800');
    const url2 = new URL(body.urls[HASH(3)].url);
    expect(url2.searchParams.get('X-Amz-Expires')).toBe('1800');
  });

  it('rejects malformed blake3', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'uu-bad-b3');
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy/upload-urls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          assets: [{ blake3: 'not-hex', md5: MD5(1), size: 1, contentType: 'text/plain' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/blake3.*32 lowercase hex/);
  });

  it('rejects malformed md5', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'uu-bad-md5');
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy/upload-urls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          assets: [{ blake3: HASH(1), md5: 'short', size: 1, contentType: 'text/plain' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/md5.*32 lowercase hex/);
  });

  it('rejects negative size', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'uu-bad-size');
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy/upload-urls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          assets: [{ blake3: HASH(1), md5: MD5(2), size: -1, contentType: 'text/plain' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  // Regression: a teardown that commits AFTER the unlocked early-out check
  // but BEFORE the FOR SHARE lock acquires must still surface as 410 from
  // the in-tx re-read. Without the in-tx check, the handler would proceed
  // to issue presigned PUT URLs against a project that's being deleted,
  // letting the CLI write durable orphan bytes that teardown's R2 sweep
  // races to clean up. We simulate the race by intercepting the second
  // `getProject` call (the one made inside the FOR SHARE transaction) so
  // it sees `status='deleting'` while the first (unlocked) call sees
  // `active`.
  it('returns 410 when status flips to deleting between unlocked check and FOR SHARE re-read', async () => {
    const { setGetProjectOverride } = await import('./setup.ts');
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'uu-race');

    let calls = 0;
    setGetProjectOverride(({ original, argsList }) => {
      calls++;
      // First call (unlocked early-out) → original = active.
      // Second call (in-tx, post FOR SHARE) → simulate teardown that
      // committed `status='deleting'` between the two reads.
      if (calls === 1) {
        return original(...argsList);
      }
      return original(...argsList).then((p) => (p ? { ...p, status: 'deleting' as const } : p));
    });

    try {
      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy/upload-urls`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            assets: [{ blake3: HASH(1), md5: MD5(2), size: 10, contentType: 'text/html' }],
          }),
        }),
        env,
      );
      expect(res.status).toBe(410);
      const body = (await res.json()) as { error: string; urls?: unknown };
      expect(body.error).toMatch(/being deleted/);
      expect(body.urls).toBeUndefined();
      // Both reads must have run: unlocked early-out + in-tx re-read.
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      setGetProjectOverride(null);
    }
  });

  // Regression: projects in `deleting` cannot finalize a deploy (the finalize
  // path returns 410). Issuing presigned R2 PUT URLs after status flips to
  // deleting would let clients leak orphaned `assets/{projectId}/*` blobs
  // during teardown. Mirrors the guard `POST /:id/deploy` already enforces.
  it('returns 410 for projects with status=deleting and never presigns bytes', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'uu-deleting');
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy/upload-urls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          assets: [{ blake3: HASH(1), md5: MD5(2), size: 10, contentType: 'text/html' }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string; urls?: unknown };
    expect(body.error).toMatch(/being deleted/);
    // Bytes must NOT be presigned — the response must not carry any `urls`.
    expect(body.urls).toBeUndefined();
  });
});

describe('POST /projects/:id/deploy (JSON mode — direct-to-R2)', () => {
  function v2Manifest(extra: Record<string, unknown> = {}) {
    return {
      version: 3,
      assetManifestVersion: 2,
      bindings: {},
      ...extra,
    };
  }

  it('static deploy with all assets pre-uploaded reaches live', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-static-ok');
    mockCfApi();

    const indexBytes = new TextEncoder().encode('<h1>hi</h1>');
    const cssBytes = new TextEncoder().encode('body { color: red }');
    const indexHash = HASH(0x1010);
    const cssHash = HASH(0x2020);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, indexHash, indexBytes);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, cssHash, cssBytes);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
          'X-Void-CLI-Version': '0.8.3',
        },
        body: JSON.stringify({
          manifest: v2Manifest({
            type: 'spa',
            assetConfig: { not_found_handling: 'single-page-application' },
          }),
          assetManifest: {
            '/index.html': { blake3: indexHash, md5: MD5(0x1011), size: indexBytes.byteLength },
            '/assets/style.css': {
              blake3: cssHash,
              md5: MD5(0x2021),
              size: cssBytes.byteLength,
            },
          },
          source: null,
          commit: null,
          preflight: null,
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const start = events.find((e) => isEvent(e, 'start'));
    const done = events.find((e) => isEvent(e, 'done'));
    expect(start).toBeDefined();
    expect(done).toBeDefined();
    // assets count + url
    const doneEvt = done as unknown as { url: string; assets: number };
    expect(doneEvt.assets).toBe(2);
    expect(doneEvt.url).toBe('https://jm-static-ok.void.app');

    // DB row reaches `live`
    const [dpl] = await env.db
      .select({ cli_version: deployments.cli_version, status: deployments.status })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpl?.status).toBe('live');
    expect(dpl?.cli_version).toBe('0.8.3');

    // Serving manifest: each path → `!{hash}` (direct-to-R2 always lands
    // in R2)
    const serving = (await env.ROUTING.get(
      `manifest:${(doneEvt as unknown as { deployment: string }).deployment}`,
      'json',
    )) as Record<string, string> | null;
    expect(serving).toEqual({
      '/index.html': `!${indexHash}`,
      '/assets/style.css': `!${cssHash}`,
    });
  });

  // Regression: a successful static deploy must opportunistically sweep
  // orphan blobs uploaded via direct-to-R2 presigned PUTs that never made
  // it into a finalized manifest. Without this, abandoned upload-urls
  // bytes accumulate forever (the eviction loop only walks evicted
  // deployments' `asset_hashes`, never the raw R2 keyspace).
  //
  // Orphans uploaded within `PENDING_UPLOAD_PROTECTION_SECONDS` (2× presign
  // TTL = 3600s) are preserved by the sweep — they may be in-flight uploads
  // for a not-yet-finalized deploy. The companion test below pins down that
  // protection-window behaviour. Here we age the orphan past the window so
  // the sweep is allowed to delete it.
  it('static deploy sweeps R2 assets/{projectId}/* orphans that were uploaded but never referenced', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-orphan-sweep');
    mockCfApi();

    const indexBytes = new TextEncoder().encode('<h1>kept</h1>');
    const indexHash = HASH(0x4a4a);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, indexHash, indexBytes);

    // Orphan: uploaded via upload-urls but never referenced by a manifest.
    const orphanHash = HASH(0xdead);
    const orphanKey = `assets/${project.id}/${orphanHash}`;
    await stageAssetInR2(
      env.STATIC_ASSETS_R2,
      project.id,
      orphanHash,
      new TextEncoder().encode('orphaned bytes'),
    );
    // Age the orphan past the pending-upload protection window so the sweep
    // is allowed to evict it. Using 2 hours leaves headroom over the 3600s
    // window and survives small clock jitter.
    (
      env.STATIC_ASSETS_R2 as unknown as { setUploadedAt: (k: string, d: Date) => void }
    ).setUploadedAt(orphanKey, new Date(Date.now() - 2 * 3600 * 1000));

    // Other-project orphan: must NOT be touched by this project's sweep.
    const otherKey = 'assets/proj_other/cccccccccccccccccccccccccccccccc';
    await env.STATIC_ASSETS_R2.put(otherKey, new Uint8Array([9, 9, 9]).buffer as ArrayBuffer);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: v2Manifest({
            type: 'spa',
            assetConfig: { not_found_handling: 'single-page-application' },
          }),
          assetManifest: {
            '/index.html': { blake3: indexHash, md5: MD5(0x4a4b), size: indexBytes.byteLength },
          },
          source: null,
          commit: null,
          preflight: null,
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    expect(events.find((e) => isEvent(e, 'done'))).toBeDefined();

    // Manifest-referenced bytes survive.
    expect(await env.STATIC_ASSETS_R2.head(`assets/${project.id}/${indexHash}`)).not.toBeNull();
    // Orphaned bytes for THIS project are gone.
    expect(await env.STATIC_ASSETS_R2.head(orphanKey)).toBeNull();
    // Other-project bytes untouched.
    expect(await env.STATIC_ASSETS_R2.head(otherKey)).not.toBeNull();
  });

  // Regression: orphans uploaded inside the pending-upload protection
  // window MUST be preserved by the retention sweep — those bytes may be
  // in-flight uploads for a not-yet-finalized deploy on the same project.
  // Deleting them would race a concurrent `upload-urls`-then-finalize flow
  // and break the second deploy with a missing-asset error. See
  // `sweepProjectAssetOrphans` in `assets.ts` for the rationale.
  it('static deploy preserves recently-uploaded R2 orphans within the pending-upload protection window', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-orphan-recent');
    mockCfApi();

    const indexBytes = new TextEncoder().encode('<h1>kept</h1>');
    const indexHash = HASH(0x4b4b);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, indexHash, indexBytes);

    // Orphan uploaded "just now" — simulates a concurrent upload-urls flow
    // for a future deploy that hasn't finalized yet. MemoryR2Bucket stamps
    // `uploaded = new Date()` on put, so no override is needed.
    const recentOrphanHash = HASH(0xbeef);
    const recentOrphanKey = `assets/${project.id}/${recentOrphanHash}`;
    await stageAssetInR2(
      env.STATIC_ASSETS_R2,
      project.id,
      recentOrphanHash,
      new TextEncoder().encode('in-flight bytes'),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: v2Manifest({
            type: 'spa',
            assetConfig: { not_found_handling: 'single-page-application' },
          }),
          assetManifest: {
            '/index.html': { blake3: indexHash, md5: MD5(0x4b4c), size: indexBytes.byteLength },
          },
          source: null,
          commit: null,
          preflight: null,
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    expect(events.find((e) => isEvent(e, 'done'))).toBeDefined();

    // Manifest-referenced bytes survive.
    expect(await env.STATIC_ASSETS_R2.head(`assets/${project.id}/${indexHash}`)).not.toBeNull();
    // Recently-uploaded orphan must STILL exist — the sweep skipped it
    // because it falls inside the protection window.
    expect(await env.STATIC_ASSETS_R2.head(recentOrphanKey)).not.toBeNull();
  });

  it('static deploy fails 4xx-style with missing-hash error when an asset is not in R2', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-static-miss');
    mockCfApi();

    const presentHash = HASH(0xa0a0);
    await stageAssetInR2(
      env.STATIC_ASSETS_R2,
      project.id,
      presentHash,
      new TextEncoder().encode('present'),
    );
    const missingHash = HASH(0xdead);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: v2Manifest({ type: 'spa' }),
          assetManifest: {
            '/index.html': { blake3: presentHash, md5: MD5(0xa0a1), size: 7 },
            '/missing.css': { blake3: missingHash, md5: MD5(0xdeae), size: 12 },
          },
          source: null,
          commit: null,
          preflight: null,
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errEvt = events.find((e) => isEvent(e, 'error')) as
      | { event: 'error'; message: string }
      | undefined;
    expect(errEvt).toBeDefined();
    expect(errEvt!.message).toContain(missingHash);
    // Deployment row should NOT be live; it should either be reaped
    // (placeholder DELETED) or in a terminal non-live status.
    const rows = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    for (const r of rows) {
      expect(r.status).not.toBe('live');
    }
  });

  it('WfP deploy with workerFiles reaches live', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-wfp-ok');
    mockCfApi();

    const assetBytes = new TextEncoder().encode('export const helper = 1;');
    const assetHash = HASH(0xb1b1);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, assetHash, assetBytes);

    // Mock DISPATCH so the migration / readiness probe paths can run if invoked.
    const originalDispatch = env.DISPATCH;
    env.DISPATCH = {
      get: () => ({
        fetch: async () => Response.json({ ready: true }),
      }),
    } as unknown as DispatchNamespace;

    try {
      const indexJs = new TextEncoder().encode(
        "export default { fetch() { return new Response('ok'); } }",
      );
      // base64 encode
      let bin = '';
      for (let i = 0; i < indexJs.length; i++) {
        bin += String.fromCharCode(indexJs[i]);
      }
      const indexJsB64 = btoa(bin);

      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            manifest: v2Manifest({ type: 'void' }),
            assetManifest: {
              '/static/helper.js': {
                blake3: assetHash,
                md5: MD5(0xb1b2),
                size: assetBytes.byteLength,
              },
            },
            source: null,
            commit: null,
            preflight: null,
            workerFiles: {
              'index.js': indexJsB64,
            },
          }),
        }),
        env,
      );
      expect(res.status).toBe(200);
      const events = await readAllEvents(res);
      const done = events.find((e) => isEvent(e, 'done')) as unknown as
        | { deployment: string; workers: number }
        | undefined;
      expect(done).toBeDefined();
      expect(done!.workers).toBe(1);
      const [dpl] = await env.db
        .select({ status: deployments.status, routing_published: deployments.routing_published })
        .from(deployments)
        .where(eq(deployments.project_id, project.id));
      expect(dpl?.status).toBe('live');
      // Full publish success sets the durable marker so the reconciler skips it.
      expect(dpl?.routing_published).toBe(true);
    } finally {
      env.DISPATCH = originalDispatch;
    }
  });

  it('dedupe short-circuit fires when manifest matches the live deploy', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-dedupe');
    mockCfApi();

    const indexBytes = new TextEncoder().encode('<h1>same</h1>');
    const indexHash = HASH(0xc1c1);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, indexHash, indexBytes);

    // Pre-seed a live deployment whose manifest matches what we'll send.
    // The dedupe compare is against the FULL enriched manifest stored on
    // the live deployment row; we mirror that exactly by JSON-stringifying
    // the manifest after enrichment is a no-op (no websocket / no sandbox).
    const liveId = 'dpl_live_jm_dedupe';
    const liveManifest = {
      version: 3,
      assetManifestVersion: 2,
      type: 'spa',
      bindings: {},
      assetConfig: { not_found_handling: 'single-page-application' },
    };
    const liveAssetManifest = {
      '/index.html': { hash: indexHash, size: indexBytes.byteLength },
    };
    await env.db.insert(deployments).values({
      id: liveId,
      project_id: project.id,
      status: 'live',
      manifest: JSON.stringify(liveManifest),
      asset_hashes: JSON.stringify(liveAssetManifest),
      created_at: sql`now()`,
      deployed_at: sql`now()`,
    });
    await env.db
      .update(projects)
      .set({ active_deployment_id: liveId })
      .where(eq(projects.id, project.id));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: liveManifest,
          assetManifest: {
            '/index.html': {
              blake3: indexHash,
              md5: MD5(0xc1c2),
              size: indexBytes.byteLength,
            },
          },
          source: null,
          commit: null,
          preflight: null,
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    // Dedupe short-circuit: only `start` + `done` for the live deployment.
    expect(events.some((e) => isEvent(e, 'start'))).toBe(true);
    const done = events.find((e) => isEvent(e, 'done')) as unknown as
      | { deployment: string }
      | undefined;
    expect(done).toBeDefined();
    expect(done!.deployment).toBe(liveId);
  });

  // Routing-after-tx contract: the go-live tx (`setActiveDeployment`) is the
  // atomic point of no return for cancellation. A cancel committed BEFORE that
  // tx aborts it → deployment canceled, ZERO routing written (the safety
  // property); a cancel arriving AFTER the commit loses the race → the deploy
  // is live (user must roll back). These two tests pin both halves.
  it('cancel before the go-live tx → canceled, prior routing untouched', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-cancel-pre');
    mockCfApi();

    // Pre-seed prior routing for the slug. The safety property is that an
    // honored pre-commit cancel writes NO routing, so this byte string must
    // survive the canceled deploy untouched.
    const priorSlugJson = JSON.stringify({ version: 'dpl_prior_live', priorMarker: true });
    await env.ROUTING.put(project.slug, priorSlugJson);

    const bytes = new TextEncoder().encode('<h1>cancel me</h1>');
    const indexHash = HASH(0xca01);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, indexHash, bytes);

    // Seam the cancel on a write that happens BEFORE the go-live tx: the
    // static path writes the serving manifest under `manifest:<deploymentId>`
    // (deploy.ts ~2815) before it enters the go-live tx and before the slug
    // write. Marking the deployment canceling here means the pre-tx
    // `assertDeploymentNotCanceled` (deploy.ts ~2840) — and, as a backstop, the
    // in-tx CAS (`markDeploymentLiveIfNotCanceled`) immediately before
    // `setActiveDeployment` — observes the cancel and aborts before any routing
    // flip. (Here the pre-tx read catches it; the CAS is the atomic backstop
    // for a cancel that commits DURING the tx — see the dedicated CAS test.)
    const originalPut = env.ROUTING.put.bind(env.ROUTING);
    let cancelTriggered = false;
    (env.ROUTING.put as unknown) = async (
      key: string,
      value: string,
      options?: { metadata?: unknown; expirationTtl?: number },
    ) => {
      if (!cancelTriggered && key.startsWith('manifest:')) {
        cancelTriggered = true;
        const rows = await env.db
          .select({ id: deployments.id })
          .from(deployments)
          .where(eq(deployments.project_id, project.id));
        if (rows.length > 0) {
          await cancelDeployment(env.db, rows[0].id, 'test cancel');
        }
        // Let the manifest write itself succeed; the abort happens at the
        // subsequent cancellation check, NOT here.
      }
      return originalPut(key, value, options);
    };

    try {
      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            manifest: v2Manifest({ type: 'spa' }),
            assetManifest: {
              '/index.html': {
                blake3: indexHash,
                md5: MD5(0xca02),
                size: bytes.byteLength,
              },
            },
            source: null,
            commit: null,
            preflight: null,
          }),
        }),
        env,
      );
      expect(res.status).toBe(200);
      await readAllEvents(res);
    } finally {
      (env.ROUTING.put as unknown) = originalPut;
    }

    expect(cancelTriggered).toBe(true); // the pre-tx seam fired

    // The deployment ended canceled (NOT failed, NOT live).
    const rows = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.status).toBe('canceled');
    }

    // Safety property: NO slug routing was written — prior routing is
    // byte-for-byte intact and keeps serving.
    expect(await env.ROUTING.get(project.slug)).toBe(priorSlugJson);

    // The active-deployment pointer never flipped to the canceled deploy
    // (no go-live tx committed, so it stays null on this fresh project).
    const canceledIds = (
      await env.db
        .select({ id: deployments.id })
        .from(deployments)
        .where(eq(deployments.project_id, project.id))
    ).map((r) => r.id);
    const [proj] = await env.db
      .select({ active_deployment_id: projects.active_deployment_id })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(canceledIds).not.toContain(proj?.active_deployment_id);

    // The pre-tx serving manifest (`manifest:<deploymentId>`) must be evicted
    // on a pre-commit abort — the catch's `!goLiveTxCommitted` branch deletes
    // it via the `wfpMirroredManifestDeploymentId` tracker (now also set on the
    // static path). Without the evict the manifest would orphan in ROUTING KV.
    for (const id of canceledIds) {
      expect(await env.ROUTING.get(`manifest:${id}`)).toBeNull();
    }
  });

  it('cancel after the go-live commit loses the race → live', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-cancel-post');
    mockCfApi();

    const bytes = new TextEncoder().encode('<h1>too late</h1>');
    const indexHash = HASH(0xcb01);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, indexHash, bytes);

    // Seam the cancel on the slug write. Under routing-after-tx the slug write
    // is POST-commit (the go-live tx, including `setActiveDeployment`, has
    // already committed), so this cancel arrives too late: the deployment is
    // already live. The cancel marks the row `canceling`, but the publish path
    // does NOT re-read it post-commit, so the deploy stays live (the point of
    // no return is the tx commit, not the slug write). The cancel lost the race
    // — the user must roll back.
    //
    // The post-commit publish now runs INSIDE `publishRoutingIfStillActive`'s
    // project-row FOR UPDATE tx (the lock+re-check that defeats stale clobbering).
    // In production `cancelDeployment` does a lock-free UPDATE on a DIFFERENT row
    // (the deployment), so it never deadlocks the publish. PGlite is a single
    // connection, though, so issuing `cancelDeployment(env.db, …)` WHILE the
    // helper tx holds the connection would self-deadlock. We therefore only RECORD
    // (inside the put seam) that the post-commit slug write was reached, then fire
    // the lost-the-race cancel AFTER the deploy request resolves — modeling a
    // cancel that lands once the deploy is already committed-live. The deploy must
    // stay live regardless (the cancel lost the race). Asserting `cancelTriggered`
    // proves the seam fired at the post-commit slug write.
    const originalPut = env.ROUTING.put.bind(env.ROUTING);
    let cancelTriggered = false;
    (env.ROUTING.put as unknown) = async (
      key: string,
      value: string,
      options?: { metadata?: unknown; expirationTtl?: number },
    ) => {
      if (!cancelTriggered && key === project.slug) {
        cancelTriggered = true;
      }
      return originalPut(key, value, options);
    };

    let doneDeploymentId: string | undefined;
    try {
      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            manifest: v2Manifest({ type: 'spa' }),
            assetManifest: {
              '/index.html': {
                blake3: indexHash,
                md5: MD5(0xcb02),
                size: bytes.byteLength,
              },
            },
            source: null,
            commit: null,
            preflight: null,
          }),
        }),
        env,
      );
      expect(res.status).toBe(200);
      const events = await readAllEvents(res);
      const done = events.find((e) => isEvent(e, 'done')) as unknown as
        | { deployment: string }
        | undefined;
      doneDeploymentId = done?.deployment;
    } finally {
      (env.ROUTING.put as unknown) = originalPut;
    }

    expect(cancelTriggered).toBe(true); // the post-commit slug-write seam fired
    expect(doneDeploymentId).toBeDefined(); // deploy reported success

    // Fire the lost-the-race cancel now (the deploy is already committed-live).
    // It marks the row `canceling`, but the deploy never re-reads cancel status
    // post-commit, so the live state below proves the cancel had no effect.
    await cancelDeployment(env.db, doneDeploymentId!, 'test cancel (lost the race)');

    // The deployment went live (cancel lost the race) and the active pointer
    // committed to it inside the go-live tx — before the cancel landed.
    const [dpl] = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.id, doneDeploymentId!));
    expect(dpl?.status).toBe('live');

    const [proj] = await env.db
      .select({ active_deployment_id: projects.active_deployment_id })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(proj?.active_deployment_id).toBe(doneDeploymentId);
  });

  // CAS atomicity (static path): the pre-tx `assertDeploymentNotCanceled` read
  // and the live write are two statements, so a cancel can commit BETWEEN them.
  // `cancelDeployment` does a lock-free UPDATE that does NOT lock the project,
  // so a plain read-then-`force:true` could ack the cancel to the user yet
  // force the deploy live anyway. The in-tx CAS closes that TOCTOU: it flips
  // status→'live' only WHERE status NOT IN ('canceling','canceled').
  //
  // PGlite is a single connection, so a concurrent separate-connection cancel
  // committing mid-tx cannot be reproduced literally (it would serialize behind
  // the open tx, or self-deadlock). We model the contract instead: the CAS seam
  // writes 'canceling' on the in-tx handle, then calls the REAL CAS — which
  // genuinely returns false via its WHERE clause (proving the gate, not a forced
  // stub), so deploy.ts throws 'deployment canceled' and the go-live tx rolls
  // back (no live flip, no routing). Because that rollback also discards the
  // in-tx 'canceling' write, we stand in for the surviving real-world cancel by
  // having the catch's `getDeployment` re-read report 'canceling' (only AFTER
  // the CAS seam fires, so the pre-tx checks still see the live-bound state).
  // The catch then finalizes to 'canceled'. This FAILS against the old
  // `force:true` write (which overwrote canceling→live) and passes with the CAS.
  it('cancel landing DURING the go-live tx → canceled via CAS, nothing published', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-cancel-mid');
    mockCfApi();

    const priorSlugJson = JSON.stringify({ version: 'dpl_prior_live', priorMarker: true });
    await env.ROUTING.put(project.slug, priorSlugJson);

    const bytes = new TextEncoder().encode('<h1>race me</h1>');
    const indexHash = HASH(0xcc01);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, indexHash, bytes);

    const originalCas = db.markDeploymentLiveIfNotCanceled;
    let casSeamFired = false;
    const casSpy = vi
      .spyOn(db, 'markDeploymentLiveIfNotCanceled')
      .mockImplementation(async (database, deploymentId) => {
        if (!casSeamFired) {
          casSeamFired = true;
          // Write 'canceling' on the in-tx handle so the REAL CAS evaluates its
          // WHERE clause against it (genuine zero-row refusal, not a stub).
          await cancelDeployment(database, deploymentId, 'test cancel (mid-tx race)');
        }
        return originalCas(database, deploymentId);
      });

    // Once the CAS seam has fired (i.e. we're past the pre-tx checks, inside the
    // doomed tx), make the catch's post-rollback `getDeployment` re-read report
    // 'canceling' — modeling the separate-connection cancel that survives the
    // rollback in production. Preserve the real row's manifest so the
    // finally-reaper (which only deletes manifest===null rows) leaves it alone.
    const originalGetDeployment = db.getDeployment;
    const getDeploymentSpy = vi
      .spyOn(db, 'getDeployment')
      .mockImplementation(async (database, id) => {
        const row = await originalGetDeployment(database, id);
        if (casSeamFired && row && id === row.id) {
          return { ...row, status: 'canceling' };
        }
        return row;
      });

    try {
      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            manifest: v2Manifest({ type: 'spa' }),
            assetManifest: {
              '/index.html': {
                blake3: indexHash,
                md5: MD5(0xcc02),
                size: bytes.byteLength,
              },
            },
            source: null,
            commit: null,
            preflight: null,
          }),
        }),
        env,
      );
      expect(res.status).toBe(200);
      await readAllEvents(res);
    } finally {
      casSpy.mockRestore();
      getDeploymentSpy.mockRestore();
    }

    expect(casSeamFired).toBe(true); // the in-tx CAS seam fired

    // The deployment ended canceled (NOT live) — the CAS refused the flip.
    const rows = await env.db
      .select({ id: deployments.id, status: deployments.status })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.status).toBe('canceled');
    }

    // The active pointer never flipped to the canceled deploy.
    const [proj] = await env.db
      .select({ active_deployment_id: projects.active_deployment_id })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(rows.map((r) => r.id)).not.toContain(proj?.active_deployment_id);

    // Safety property: NO slug routing was published — prior routing intact.
    expect(await env.ROUTING.get(project.slug)).toBe(priorSlugJson);
  });

  // `published` honesty (static path): the deploy commits live, then publishes
  // routing post-tx with one retry. When BOTH attempts fail (exhausted
  // retries) the deploy stays committed-live but routing never published — the
  // `done` event must carry `published: false` (NOT an `error`; the deploy is
  // live). Routing self-heals on the next deploy/rollback from the active
  // deployment's manifest.
  it('static post-commit routing publish failure → done with published:false', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-pub-fail');
    mockCfApi();

    const bytes = new TextEncoder().encode('<h1>committed</h1>');
    const indexHash = HASH(0xcd01);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, indexHash, bytes);

    // Fail the slug put on BOTH the initial publish and the retry. The slug
    // write is post-commit, so the go-live tx has already committed live.
    const originalPut = env.ROUTING.put.bind(env.ROUTING);
    let slugPutAttempts = 0;
    (env.ROUTING.put as unknown) = async (
      key: string,
      value: string,
      options?: { metadata?: unknown; expirationTtl?: number },
    ) => {
      if (key === project.slug) {
        slugPutAttempts++;
        throw new Error('transient KV failure');
      }
      return originalPut(key, value, options);
    };

    let events: Array<unknown> = [];
    try {
      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            manifest: v2Manifest({ type: 'spa' }),
            assetManifest: {
              '/index.html': {
                blake3: indexHash,
                md5: MD5(0xcd02),
                size: bytes.byteLength,
              },
            },
            source: null,
            commit: null,
            preflight: null,
          }),
        }),
        env,
      );
      expect(res.status).toBe(200);
      events = await readAllEvents(res);
    } finally {
      (env.ROUTING.put as unknown) = originalPut;
    }

    // Both publish attempts fired (retry path exercised).
    expect(slugPutAttempts).toBeGreaterThanOrEqual(2);

    // NOT an error — the deploy committed live.
    expect(events.find((e) => isEvent(e, 'error'))).toBeUndefined();

    // The `done` event reports `published: false` (no longer lying).
    const done = events.find((e) => isEvent(e, 'done')) as unknown as
      | { deployment: string; published?: boolean }
      | undefined;
    expect(done).toBeDefined();
    expect(done!.published).toBe(false);

    // The deployment is live and the active pointer committed to it.
    const [dpl] = await env.db
      .select({ status: deployments.status, routing_published: deployments.routing_published })
      .from(deployments)
      .where(eq(deployments.id, done!.deployment));
    expect(dpl?.status).toBe('live');
    // Publish failed → the durable marker is NOT set (the reconciler will heal).
    expect(dpl?.routing_published ?? null).not.toBe(true);
    const [proj] = await env.db
      .select({ active_deployment_id: projects.active_deployment_id })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(proj?.active_deployment_id).toBe(done!.deployment);
  });

  // F31 DISCRIMINATOR (static path). A FAILED routing publish must NOT delete
  // the worker that is still serving stale KV. The epilogue's irreversible
  // project-keyed cleanup (legacy worker delete + retained-worker delete loop +
  // retention/asset eviction) USED to be gated only on `isStillActiveDeployment`.
  // On `publishOutcome === 'failed'` the go-live tx already committed, so the new
  // deploy IS the DB-active deployment → `isStillActiveDeployment` returns true →
  // the cleanup ran. But the routing publish FAILED, so dispatch's slug/domain KV
  // still points at the PREVIOUS deployment's worker. The old code then deleted
  // that previous worker (and evicted its `manifest:<prevId>`) — and the
  // reconciler can republish KV but CANNOT recreate a deleted CF worker script →
  // up-to-1h outage. The fix gates the cleanup on
  // `staticPublishOutcome === 'published'` AND `isStillActiveDeployment`.
  //
  // PROOF: pre-fix the previous worker is deleted (this test fails); post-fix it
  // survives and the deploy is reported degraded (`published: false`).
  it('F31: static publish failure does NOT delete the previous worker still serving stale KV', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-f31-static');
    const handle = mockCfApi();

    // Prior retained WfP (`void`) deployment — its worker IS targeted by the
    // static path's retained-worker delete loop (the loop skips only
    // static/spa candidates). Terminal `failed` so the new deploy's
    // precheck-and-claim doesn't treat it as a concurrent in-flight deploy.
    const prevAssetHash = HASH(0xf311);
    const prev = await db.createDeployment(
      env.db,
      project.id,
      JSON.stringify({
        version: 2,
        type: 'void',
        assetManifest: { '/old.js': { hash: prevAssetHash } },
      }),
    );
    await db.updateDeploymentStatus(env.db, prev.id, 'failed');
    await db.markDeploymentRetained(env.db, prev.id, true);
    // The retention/asset eviction pass reads `asset_hashes` (the column written
    // at deploy time) to evict `manifest:<prevId>` — seed it so the eviction
    // path would actually fire on the buggy code.
    await env.db
      .update(deployments)
      .set({ asset_hashes: JSON.stringify({ '/old.js': { hash: prevAssetHash } }) })
      .where(eq(deployments.id, prev.id));
    // The previous deploy is the one currently serving: make it the active
    // pointer (the new deploy's go-live flips it) and seed its live worker +
    // serving manifest into the mock so a delete would be observable.
    await env.db
      .update(projects)
      .set({ active_deployment_id: prev.id })
      .where(eq(projects.id, project.id));
    const prevWorkerName = `user-${project.slug}-${prev.id}`;
    handle.seedHostScript({ scriptName: prevWorkerName });
    await env.ROUTING.put(`manifest:${prev.id}`, JSON.stringify({ '/old.js': prevAssetHash }));

    const bytes = new TextEncoder().encode('<h1>new</h1>');
    const indexHash = HASH(0xf312);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, indexHash, bytes);

    // Fail the slug put on BOTH the initial publish and the retry →
    // `staticPublishOutcome === 'failed'`.
    const originalPut = env.ROUTING.put.bind(env.ROUTING);
    let slugPutAttempts = 0;
    (env.ROUTING.put as unknown) = async (
      key: string,
      value: string,
      options?: { metadata?: unknown; expirationTtl?: number },
    ) => {
      if (key === project.slug) {
        slugPutAttempts++;
        throw new Error('transient KV failure');
      }
      return originalPut(key, value, options);
    };

    let events: Array<unknown> = [];
    try {
      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            manifest: v2Manifest({ type: 'spa' }),
            assetManifest: {
              '/index.html': {
                blake3: indexHash,
                md5: MD5(0xf313),
                size: bytes.byteLength,
              },
            },
            source: null,
            commit: null,
            preflight: null,
          }),
        }),
        env,
      );
      expect(res.status).toBe(200);
      events = await readAllEvents(res);
    } finally {
      (env.ROUTING.put as unknown) = originalPut;
    }

    // Both publish attempts fired (the publish actually failed, not skipped).
    expect(slugPutAttempts).toBeGreaterThanOrEqual(2);

    // Degraded, not errored: the deploy committed live but did not publish.
    expect(events.find((e) => isEvent(e, 'error'))).toBeUndefined();
    const done = events.find((e) => isEvent(e, 'done')) as unknown as
      | { deployment: string; published?: boolean }
      | undefined;
    expect(done).toBeDefined();
    expect(done!.published).toBe(false);

    // CORE PROOF: the previous worker still serving stale KV must NOT be deleted,
    // and its serving manifest must NOT be evicted.
    const deletedPrevWorker = handle.state.recordedCalls.some(
      (c) => c.method === 'DELETE' && c.url.endsWith(`/scripts/${prevWorkerName}`),
    );
    expect(deletedPrevWorker).toBe(false);
    expect(handle.state.hostScripts.has(prevWorkerName)).toBe(true);
    expect(await env.ROUTING.get(`manifest:${prev.id}`)).not.toBeNull();
  });

  // F31 DISCRIMINATOR (WfP path). Same gate as the static path: a FAILED routing
  // publish must not run the irreversible retained-worker delete loop. New WfP
  // (`void`) deploy whose publish fails; the previous retained WfP worker
  // (`user-<slug>-<prevId>`) must survive.
  it('F31: WfP publish failure does NOT delete the previous worker still serving stale KV', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-f31-wfp');
    const handle = mockCfApi();

    const originalDispatch = env.DISPATCH;
    env.DISPATCH = {
      get: () => ({
        fetch: async () => Response.json({ ready: true }),
      }),
    } as unknown as DispatchNamespace;

    const prevAssetHash = HASH(0xf321);
    const prev = await db.createDeployment(
      env.db,
      project.id,
      JSON.stringify({
        version: 2,
        type: 'void',
        assetManifest: { '/old.js': { hash: prevAssetHash } },
      }),
    );
    await db.updateDeploymentStatus(env.db, prev.id, 'failed');
    await db.markDeploymentRetained(env.db, prev.id, true);
    await env.db
      .update(deployments)
      .set({ asset_hashes: JSON.stringify({ '/old.js': { hash: prevAssetHash } }) })
      .where(eq(deployments.id, prev.id));
    await env.db
      .update(projects)
      .set({ active_deployment_id: prev.id })
      .where(eq(projects.id, project.id));
    const prevWorkerName = `user-${project.slug}-${prev.id}`;
    handle.seedHostScript({ scriptName: prevWorkerName });
    await env.ROUTING.put(`manifest:${prev.id}`, JSON.stringify({ '/old.js': prevAssetHash }));

    const assetBytes = new TextEncoder().encode('export const helper = 1;');
    const assetHash = HASH(0xf322);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, assetHash, assetBytes);

    // Fail the slug put on BOTH publish attempts → `wfpPublishOutcome` is failed.
    const originalPut = env.ROUTING.put.bind(env.ROUTING);
    let slugPutAttempts = 0;
    (env.ROUTING.put as unknown) = async (
      key: string,
      value: string,
      options?: { metadata?: unknown; expirationTtl?: number },
    ) => {
      if (key === project.slug) {
        slugPutAttempts++;
        throw new Error('transient KV failure');
      }
      return originalPut(key, value, options);
    };

    let events: Array<unknown> = [];
    try {
      const indexJs = new TextEncoder().encode(
        "export default { fetch() { return new Response('ok'); } }",
      );
      let bin = '';
      for (let i = 0; i < indexJs.length; i++) {
        bin += String.fromCharCode(indexJs[i]);
      }
      const indexJsB64 = btoa(bin);

      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            manifest: v2Manifest({ type: 'void' }),
            assetManifest: {
              '/static/helper.js': {
                blake3: assetHash,
                md5: MD5(0xf323),
                size: assetBytes.byteLength,
              },
            },
            source: null,
            commit: null,
            preflight: null,
            workerFiles: { 'index.js': indexJsB64 },
          }),
        }),
        env,
      );
      expect(res.status).toBe(200);
      events = await readAllEvents(res);
    } finally {
      (env.ROUTING.put as unknown) = originalPut;
      env.DISPATCH = originalDispatch;
    }

    expect(slugPutAttempts).toBeGreaterThanOrEqual(2);
    expect(events.find((e) => isEvent(e, 'error'))).toBeUndefined();
    const done = events.find((e) => isEvent(e, 'done')) as unknown as
      | { deployment: string; published?: boolean }
      | undefined;
    expect(done).toBeDefined();
    expect(done!.published).toBe(false);

    const deletedPrevWorker = handle.state.recordedCalls.some(
      (c) => c.method === 'DELETE' && c.url.endsWith(`/scripts/${prevWorkerName}`),
    );
    expect(deletedPrevWorker).toBe(false);
    expect(handle.state.hostScripts.has(prevWorkerName)).toBe(true);
    expect(await env.ROUTING.get(`manifest:${prev.id}`)).not.toBeNull();
  });

  // RACE REGRESSION (deploy-side: deploy-vs-rollback). A deploy commits live +
  // flips the active pointer to its NEW deployment, then PARKS its post-commit
  // publisher. Meanwhile a ROLLBACK (which does NOT go through the deploy's
  // precheck-and-claim, so it is the reachable concurrent-op on the same project)
  // commits + flips the active pointer to an older retained deployment +
  // publishes + marks it. When the deploy's parked publisher RESUMES it must SKIP
  // (superseded) — `publishRoutingIfStillActive` re-acquires the project-row FOR
  // UPDATE lock, re-reads `active_deployment_id`, sees the rollback target, and
  // writes NOTHING. Final routing converges to the active (rollback) deployment
  // with NO stale clobber. The OLD code (lock-free publish + unconditional
  // `markRoutingPublished`) let the parked deploy publisher overwrite the
  // rollback's slug route and stamp its own stale row published, which the
  // reconciler could never heal (the rollback target is already published).
  //
  // PGlite is single-connection, so the interleave is seamed SEQUENTIALLY: start
  // the deploy, wait until its publisher parks (its go-live tx has committed and
  // released the connection — the barrier is OUTSIDE any tx, so parking it does
  // NOT block the rollback), run the rollback to completion, then release the
  // deploy.
  it('deploy-vs-rollback: a deploy whose parked publisher resumes after a rollback committed must SKIP (superseded) — routing converges to the rollback target, no clobber', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-deploy-race');
    mockCfApi();

    // Older retained deployment B (the rollback target). Seeded retained with a
    // static manifest. Its status is a TERMINAL `failed` (the same shape the
    // rollback-vs-rollback tests use for retained targets) so that the deploy's
    // precheck-and-claim does not treat it as a concurrent in-flight deploy
    // (`getActiveDeployment` excludes terminal statuses) — the deploy below must
    // proceed to its own go-live, then a rollback re-activates depB.
    const depB = await db.createDeployment(
      env.db,
      project.id,
      JSON.stringify({
        version: 2,
        type: 'spa',
        assetConfig: { not_found_handling: 'single-page-application' },
      }),
    );
    await db.updateDeploymentStatus(env.db, depB.id, 'failed');
    await db.markDeploymentRetained(env.db, depB.id, true);

    const bytes = new TextEncoder().encode('<h1>race</h1>');
    const indexHash = HASH(0xce01);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, indexHash, bytes);

    // Park the deploy's publisher on a barrier BEFORE it acquires the helper's
    // FOR UPDATE lock; capture its deploymentId. The rollback's publisher (target
    // depB) passes straight through to the real helper.
    let releaseDeploy: () => void = () => {};
    const deployHold = new Promise<void>((r) => {
      releaseDeploy = r;
    });
    let deployReached: (() => void) | undefined;
    const deployReachedPublish = new Promise<void>((r) => {
      deployReached = r;
    });
    let deployDeploymentId: string | undefined;
    const realPublish = db.publishRoutingIfStillActive;
    const publishSpy = vi
      .spyOn(db, 'publishRoutingIfStillActive')
      .mockImplementation(async (database, projectId, deploymentId, publish) => {
        // Park ONLY the deploy's publisher (the first call, whose target is NOT
        // the pre-seeded rollback target depB).
        if (deployDeploymentId === undefined && deploymentId !== depB.id) {
          deployDeploymentId = deploymentId;
          deployReached?.();
          await deployHold; // park the deploy until the rollback published + marked
        }
        return realPublish(database, projectId, deploymentId, publish);
      });

    let done: { deployment: string; published?: boolean } | undefined;
    try {
      // Deploy: commits live (active flips to the new deployment), then parks at
      // its publisher barrier.
      const deployPromise = app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            manifest: v2Manifest({ type: 'spa' }),
            assetManifest: {
              '/index.html': { blake3: indexHash, md5: MD5(0xce02), size: bytes.byteLength },
            },
            source: null,
            commit: null,
            preflight: null,
          }),
        }),
        env,
      );
      await deployReachedPublish;

      // Rollback to depB runs to completion while the deploy is parked — commits
      // (active flips to depB), publishes depB's routing (real helper →
      // 'published'), marks depB.
      const rollbackRes = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/rollback`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ deploymentId: depB.id }),
        }),
        env,
      );
      expect(rollbackRes.status).toBe(200);

      // Release the deploy → its parked publisher runs the REAL helper, sees
      // active=depB != the deploy's deployment → 'superseded': writes nothing,
      // marks nothing.
      releaseDeploy();
      const res = await deployPromise;
      expect(res.status).toBe(200);
      done = (await readAllEvents(res)).find((e) => isEvent(e, 'done')) as unknown as
        | { deployment: string; published?: boolean }
        | undefined;
      expect(done).toBeDefined();
      // The deploy committed live but did NOT publish routing (superseded). It
      // does NOT report a clobbering success — `published` is false (honest: a
      // newer op owns routing), NOT an error (the deploy is committed-live).
      expect(done!.published).toBe(false);
      expect(done!.deployment).toBe(deployDeploymentId);
    } finally {
      publishSpy.mockRestore();
    }

    expect(deployDeploymentId).toBeDefined();
    expect(deployDeploymentId).not.toBe(depB.id);

    // pg active = the rollback target depB (rollback committed last).
    const [proj] = await env.db
      .select({ active_deployment_id: projects.active_deployment_id })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(proj?.active_deployment_id).toBe(depB.id);

    // CONVERGENCE: the published slug route points at the ACTIVE (rollback)
    // deployment depB, NOT at the deploy's stale version. The deploy's resumed
    // publish was superseded → no clobber. (Under the OLD code this would be the
    // deploy's deployment.)
    const slugEntry = (await env.ROUTING.get(project.slug, 'json')) as { version: string };
    expect(slugEntry.version).toBe(depB.id);
    expect(slugEntry.version).not.toBe(deployDeploymentId);

    // The rollback target is marked routing_published; the deploy's stale row is
    // NOT (its publish was superseded), so the reconciler will never replay it.
    const [bRow] = await env.db
      .select({ routing_published: deployments.routing_published })
      .from(deployments)
      .where(eq(deployments.id, depB.id));
    expect(bRow?.routing_published).toBe(true);
    const [deployRow] = await env.db
      .select({ routing_published: deployments.routing_published })
      .from(deployments)
      .where(eq(deployments.id, deployDeploymentId!));
    expect(deployRow?.routing_published ?? null).not.toBe(true);
  });

  // F28 discriminator (static publisher; rollback + reconciler share the
  // pattern). A guarded suspension (`guardedRoutingKvRmw` — the admin/UsageCounter
  // path) stamps `suspended` onto the slug route while a static deploy's publisher
  // is parked BEFORE it takes the publish lock. The deploy built its `routingJson`
  // from a PRE-LOCK snapshot of the slug entry that had NO `suspended`. When the
  // publisher resumes it must RE-READ the slug entry under the lock and carry the
  // CURRENT `suspended` into the published route — so the suspension survives.
  //
  // Without the fix the publisher writes the stale prebuilt JSON that lacks
  // `suspended`, dropping the freshly-stamped marker — dispatch (which enforces
  // suspension from `routing.suspended`) keeps serving a suspended project until
  // another mutation re-stamps, and the reconciler never heals it (the deploy is
  // marked `routing_published=true`).
  //
  // Seam: pre-seed a live slug route (no `suspended`) so the suspension RMW has a
  // key to stamp. Park the deploy's publisher on a barrier OUTSIDE the helper
  // lock; while parked, run the real `guardedRoutingKvRmw` to stamp `suspended`
  // (it takes + releases the project lock — the parked publisher does not hold it
  // yet). Release → the publisher takes the lock and publishes.
  it('static deploy publisher preserves a `suspended` marker stamped while it was parked (re-read under lock)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f28-static-suspend');
    mockCfApi();

    // Pre-seed a live slug route WITHOUT `suspended` — the prior deployment's
    // route, and the snapshot the new deploy reads pre-lock.
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({
        staticDeploymentId: 'dpl_prior',
        projectId: project.id,
        version: 'dpl_prior',
      }),
    );

    const bytes = new TextEncoder().encode('<h1>f28</h1>');
    const indexHash = HASH(0xf280);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, indexHash, bytes);

    // Park the deploy's publisher BEFORE it enters the real helper; capture its
    // deploymentId.
    let releaseDeploy: () => void = () => {};
    const deployHold = new Promise<void>((r) => {
      releaseDeploy = r;
    });
    let deployReached: (() => void) | undefined;
    const deployReachedPublish = new Promise<void>((r) => {
      deployReached = r;
    });
    let deployDeploymentId: string | undefined;
    const realPublish = db.publishRoutingIfStillActive;
    const publishSpy = vi
      .spyOn(db, 'publishRoutingIfStillActive')
      .mockImplementation(async (database, projectId, deploymentId, publish) => {
        if (deployDeploymentId === undefined) {
          deployDeploymentId = deploymentId;
          deployReached?.();
          await deployHold; // park until the suspension marker is stamped
        }
        return realPublish(database, projectId, deploymentId, publish);
      });

    const REASON = 'admin_suspended';
    let done: { deployment: string; published?: boolean } | undefined;
    try {
      const deployPromise = app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            manifest: v2Manifest({
              type: 'spa',
              assetConfig: { not_found_handling: 'single-page-application' },
            }),
            assetManifest: {
              '/index.html': { blake3: indexHash, md5: MD5(0xf281), size: bytes.byteLength },
            },
            source: null,
            commit: null,
            preflight: null,
          }),
        }),
        env,
      );
      await deployReachedPublish;

      // Guarded suspension stamps `suspended` on the slug route UNDER the project
      // lock (the deploy publisher is parked before it takes the same lock).
      await db.guardedRoutingKvRmw(env.db, project.id, env.ROUTING, project.slug, (entry) => {
        if (entry.suspended === REASON) {
          return null;
        }
        entry.suspended = REASON;
        return entry;
      });
      // Sanity: the marker is present before the deploy publishes.
      const mid = (await env.ROUTING.get(project.slug, 'json')) as { suspended?: string };
      expect(mid.suspended).toBe(REASON);

      releaseDeploy();
      const res = await deployPromise;
      expect(res.status).toBe(200);
      done = (await readAllEvents(res)).find((e) => isEvent(e, 'done')) as unknown as
        | { deployment: string; published?: boolean }
        | undefined;
      expect(done).toBeDefined();
      // The deploy is the active deployment → it published routing.
      expect(done!.published).toBe(true);
    } finally {
      publishSpy.mockRestore();
    }

    // DISCRIMINATOR: the published slug route is the NEW deployment's route AND
    // it STILL carries the `suspended` marker the publisher re-read under the
    // lock. Without the fix `suspended` is dropped (the stale prebuilt JSON
    // lacked it).
    const slugEntry = (await env.ROUTING.get(project.slug, 'json')) as {
      version: string;
      suspended?: string;
    };
    expect(slugEntry.version).toBe(done!.deployment);
    expect(slugEntry.suspended).toBe(REASON);
  });

  // F8 (CRITICAL): static-deploy-vs-rollback-to-WfP.
  //
  // A STATIC deploy commits live + flips the active pointer to its new
  // deployment, then PARKS its post-commit publisher. Meanwhile a ROLLBACK
  // re-activates a RETAINED WfP deployment (depW). depW is therefore active AND
  // still retained, so it appears in `getRetainedDeploymentsExcluding(project,
  // staticDeployId)` (the static epilogue's cleanup set). When the static
  // deploy's parked publisher resumes it returns 'superseded' (active=depW).
  //
  // BUG (pre-fix): on 'superseded' the static epilogue still FELL THROUGH to its
  // project-keyed cleanup — `clearCronScheduler(projectId)` + the loop that
  // deletes `user-${slug}-${old.id}` for every retained `old`. Because depW is
  // retained, that loop DELETES the live WfP worker `user-${slug}-${depW.id}`
  // while ROUTING + routing_published point at it. The reconciler cannot
  // recreate worker scripts → unrecoverable outage.
  //
  // FIX: 'superseded' SKIPS the whole project-keyed epilogue. depW's worker
  // survives, its crons survive, and routing/active still point at depW.
  it('F8: static deploy superseded by a rollback to a RETAINED WfP deployment must NOT delete the active WfP worker (critical)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f8-static-vs-wfp');
    const handle = mockCfApi();

    // CRON spy: replace CRON_SCHEDULER with one that records every DO pathname.
    // Reset AFTER the rollback (which legitimately syncs depW's schedules) and
    // BEFORE releasing the parked static deploy, so any cron call recorded is
    // attributable to the resumed (superseded) static deploy alone.
    const cronCalls: Array<string> = [];
    const originalCron = env.CRON_SCHEDULER;
    env.CRON_SCHEDULER = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (_id: unknown) => ({
        fetch: async (req: Request) => {
          cronCalls.push(new URL(req.url).pathname);
          return Response.json({ ok: true });
        },
      }),
    } as unknown as DurableObjectNamespace;

    // Retained WfP target depW with one schedule (so the rollback runs a real
    // cron /sync against it — the thing the stale deploy must not clobber).
    const depW = await db.createDeployment(
      env.db,
      project.id,
      JSON.stringify({
        version: 2,
        type: 'void',
        bindings: {},
        schedules: [{ name: 'nightly', cron: '0 0 * * *' }],
      }),
    );
    await db.updateDeploymentStatus(env.db, depW.id, 'failed');
    await db.markDeploymentRetained(env.db, depW.id, true);

    // Seed depW's live WfP worker script so the (buggy) cleanup loop has a real
    // script to delete — `state.hostScripts.has()` is then a true discriminator.
    const depWWorker = `user-${project.slug}-${depW.id}`;
    handle.seedHostScript({ scriptName: depWWorker });
    expect(handle.state.hostScripts.has(depWWorker)).toBe(true);

    const bytes = new TextEncoder().encode('<h1>f8</h1>');
    const indexHash = HASH(0xf801);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, indexHash, bytes);

    let releaseDeploy: () => void = () => {};
    const deployHold = new Promise<void>((r) => {
      releaseDeploy = r;
    });
    let deployReached: (() => void) | undefined;
    const deployReachedPublish = new Promise<void>((r) => {
      deployReached = r;
    });
    let deployDeploymentId: string | undefined;
    const realPublish = db.publishRoutingIfStillActive;
    const publishSpy = vi
      .spyOn(db, 'publishRoutingIfStillActive')
      .mockImplementation(async (database, projectId, deploymentId, publish) => {
        // Park ONLY the static deploy's publisher (target NOT the rollback
        // target depW).
        if (deployDeploymentId === undefined && deploymentId !== depW.id) {
          deployDeploymentId = deploymentId;
          deployReached?.();
          await deployHold;
        }
        return realPublish(database, projectId, deploymentId, publish);
      });

    let done: { deployment: string; published?: boolean } | undefined;
    try {
      const deployPromise = app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            manifest: v2Manifest({ type: 'spa' }),
            assetManifest: {
              '/index.html': { blake3: indexHash, md5: MD5(0xf802), size: bytes.byteLength },
            },
            source: null,
            commit: null,
            preflight: null,
          }),
        }),
        env,
      );
      await deployReachedPublish;

      // Rollback to the WfP depW — commits (active flips to depW), publishes
      // depW's WfP routing, syncs depW's crons.
      const rollbackRes = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/rollback`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ deploymentId: depW.id }),
        }),
        env,
      );
      expect(rollbackRes.status).toBe(200);
      // depW's worker is still present and its crons were synced by the
      // rollback (the legitimate, expected state we now protect).
      expect(handle.state.hostScripts.has(depWWorker)).toBe(true);
      // Reset cron call log: from here, only the resumed deploy can add calls.
      cronCalls.length = 0;

      // Release the static deploy → resumes, sees active=depW → 'superseded'.
      releaseDeploy();
      const res = await deployPromise;
      expect(res.status).toBe(200);
      done = (await readAllEvents(res)).find((e) => isEvent(e, 'done')) as unknown as
        | { deployment: string; published?: boolean }
        | undefined;
      expect(done).toBeDefined();
      expect(done!.published).toBe(false);
      expect(done!.deployment).toBe(deployDeploymentId);
    } finally {
      publishSpy.mockRestore();
      env.CRON_SCHEDULER = originalCron;
    }

    // CRITICAL: the rollback's live WfP worker was NOT deleted by the stale
    // static deploy's superseded epilogue.
    expect(handle.state.hostScripts.has(depWWorker)).toBe(true);
    // No DELETE was issued against depW's worker by the resumed deploy.
    const deletedDepWWorker = handle.state.recordedCalls.some(
      (c) => c.method === 'DELETE' && c.url.includes(`/scripts/${depWWorker}`),
    );
    expect(deletedDepWWorker).toBe(false);
    // The stale deploy issued NO cron call (no /clear) after the rollback.
    expect(cronCalls).toEqual([]);

    // active + ROUTING still point at the rollback target depW.
    const [proj] = await env.db
      .select({ active_deployment_id: projects.active_deployment_id })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(proj?.active_deployment_id).toBe(depW.id);
    const slugEntry = (await env.ROUTING.get(project.slug, 'json')) as { version: string };
    expect(slugEntry.version).toBe(depW.id);
    expect(slugEntry.version).not.toBe(deployDeploymentId);
  });

  // F9: WfP-deploy-vs-rollback — a superseded WfP deploy must NOT run its
  // project-keyed cron sync/clear (the active deployment's crons must survive).
  //
  // The cron DO is project-keyed, so the stale deploy's cron block would clobber
  // whatever the now-active op synced: a stale NO-cron deploy would /clear the
  // active's schedules; a stale CRON deploy would /sync the OLD worker/token.
  // Both sub-cases are exercised.
  //
  // The deploy is parked at `publishRoutingIfStillActive` (which runs BEFORE the
  // cron block); the cron spy is reset after the rollback + before release, so
  // any recorded cron call is the resumed (superseded) deploy's.
  for (const variant of ['no-cron-clears-active', 'cron-syncs-old'] as const) {
    it(`F9 (${variant}): superseded WfP deploy must NOT call cron sync/clear`, async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, `f9-${variant}`);
      mockCfApi();

      const originalDispatch = env.DISPATCH;
      env.DISPATCH = {
        get: () => ({ fetch: async () => Response.json({ ready: true }) }),
      } as unknown as DispatchNamespace;

      const cronCalls: Array<string> = [];
      const originalCron = env.CRON_SCHEDULER;
      env.CRON_SCHEDULER = {
        idFromName: (name: string) => ({ toString: () => name }),
        get: (_id: unknown) => ({
          fetch: async (req: Request) => {
            cronCalls.push(new URL(req.url).pathname);
            return Response.json({ ok: true });
          },
        }),
      } as unknown as DurableObjectNamespace;

      // Static rollback target depB (a static rollback does NOT delete the
      // deploy's WfP worker and keeps this scenario isolated to cron).
      const depB = await db.createDeployment(
        env.db,
        project.id,
        JSON.stringify({
          version: 2,
          type: 'spa',
          assetConfig: { not_found_handling: 'single-page-application' },
        }),
      );
      await db.updateDeploymentStatus(env.db, depB.id, 'failed');
      await db.markDeploymentRetained(env.db, depB.id, true);

      // Stale WfP deploy manifest: variant decides whether it declares crons.
      const wfpManifest =
        variant === 'cron-syncs-old'
          ? v2Manifest({ type: 'void', schedules: [{ name: 'nightly', cron: '0 0 * * *' }] })
          : v2Manifest({ type: 'void' });

      const workerBytes = new TextEncoder().encode(
        "export default { fetch() { return new Response('f9'); } }",
      );
      let bin = '';
      for (let i = 0; i < workerBytes.length; i++) {
        bin += String.fromCharCode(workerBytes[i]);
      }
      const workerFiles: Record<string, string> = { 'index.js': btoa(bin) };

      let releaseDeploy: () => void = () => {};
      const deployHold = new Promise<void>((r) => {
        releaseDeploy = r;
      });
      let deployReached: (() => void) | undefined;
      const deployReachedPublish = new Promise<void>((r) => {
        deployReached = r;
      });
      let deployDeploymentId: string | undefined;
      const realPublish = db.publishRoutingIfStillActive;
      const publishSpy = vi
        .spyOn(db, 'publishRoutingIfStillActive')
        .mockImplementation(async (database, projectId, deploymentId, publish) => {
          if (deployDeploymentId === undefined && deploymentId !== depB.id) {
            deployDeploymentId = deploymentId;
            deployReached?.();
            await deployHold;
          }
          return realPublish(database, projectId, deploymentId, publish);
        });

      try {
        const deployPromise = app.fetch(
          new Request(`http://localhost/projects/${project.id}/deploy`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              manifest: wfpManifest,
              assetManifest: {},
              source: null,
              commit: null,
              preflight: null,
              workerFiles,
            }),
          }),
          env,
        );
        await deployReachedPublish;

        const rollbackRes = await app.fetch(
          new Request(`http://localhost/projects/${project.id}/rollback`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ deploymentId: depB.id }),
          }),
          env,
        );
        expect(rollbackRes.status).toBe(200);
        // Isolate: only the resumed (superseded) deploy can add cron calls now.
        cronCalls.length = 0;

        releaseDeploy();
        const res = await deployPromise;
        expect(res.status).toBe(200);
        const done = (await readAllEvents(res)).find((e) => isEvent(e, 'done')) as unknown as
          | { deployment: string; published?: boolean }
          | undefined;
        expect(done).toBeDefined();
        expect(done!.published).toBe(false);
        expect(done!.deployment).toBe(deployDeploymentId);
      } finally {
        publishSpy.mockRestore();
        env.DISPATCH = originalDispatch;
        env.CRON_SCHEDULER = originalCron;
      }

      // The superseded WfP deploy ran NO cron sync/clear — the active (rollback)
      // deployment's crons are untouched.
      expect(cronCalls).toEqual([]);

      // active + ROUTING converge on the rollback target depB.
      const [proj] = await env.db
        .select({ active_deployment_id: projects.active_deployment_id })
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(proj?.active_deployment_id).toBe(depB.id);
      const slugEntry = (await env.ROUTING.get(project.slug, 'json')) as { version: string };
      expect(slugEntry.version).toBe(depB.id);
    });
  }

  // F13 (Finding 3): a deploy that DROPS a queue binding must sweep the stale
  // `queue:<projectId>-<old>` route. The static publish closure had NO queue
  // handling pre-fix (and the WfP closure wrote new queue keys but never
  // deleted dropped ones), so a successful publish marks the row published and
  // the reconciler — which only heals UNPUBLISHED rows — never reaches it. The
  // stale key dispatches batches to a dead/old worker forever.
  //
  // Discriminator: pre-seed a stale `queue:<projectId>-old` route (as if a prior
  // WfP deploy bound it), then deploy STATIC (which binds no queues). Pre-fix the
  // static closure never touched queue routes → the stale key SURVIVES (FAIL).
  // Post-fix the static closure sweeps every queue route the project no longer
  // binds → the stale key is GONE (PASS).
  it('F13: a static deploy superseding a WfP-with-queues deploy sweeps the stale queue route', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f13-queue-sweep');
    mockCfApi();

    // Stale queue route left by a (notional) prior WfP deploy that bound `old`.
    const staleQueueKey = `queue:${getProjectQueueName(project.id, 'old')}`;
    await env.ROUTING.put(
      staleQueueKey,
      JSON.stringify({
        workerName: `user-${project.slug}-dpl_stale`,
        projectId: project.id,
        queueName: 'old',
        proxyToken: 'stale-token',
      }),
    );
    expect(await env.ROUTING.get(staleQueueKey)).not.toBeNull();

    const bytes = new TextEncoder().encode('<h1>f13</h1>');
    const indexHash = HASH(0xf1301);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, indexHash, bytes);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manifest: v2Manifest({ type: 'spa' }),
          assetManifest: {
            '/index.html': { blake3: indexHash, md5: MD5(0xf1302), size: bytes.byteLength },
          },
          source: null,
          commit: null,
          preflight: null,
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const done = (await readAllEvents(res)).find((e) => isEvent(e, 'done')) as unknown as
      | { published?: boolean }
      | undefined;
    expect(done?.published).toBe(true);

    // The stale queue route was swept by the static publish closure.
    expect(await env.ROUTING.get(staleQueueKey)).toBeNull();
  });

  // F14 (Finding 2): flip-AFTER-publish. A static deploy's publish returns
  // 'published' (it WAS active at publish time), but a concurrent rollback flips
  // the active pointer to a retained WfP deployment depW in the window AFTER the
  // publish lock is released and BEFORE the static deploy's project-keyed
  // epilogue runs. The OLD guard only skipped the epilogue on 'superseded'
  // (flip-BEFORE-publish), so on 'published' it FELL THROUGH and deleted
  // `user-${slug}-${depW.id}` (depW is retained, hence in
  // getRetainedDeploymentsExcluding) and ran clearCronScheduler against the
  // project — clobbering the now-active rollback target. The worker delete is
  // unrecoverable.
  //
  // Discriminator: spy on publishRoutingIfStillActive so the static deploy's
  // publish runs for real (returns 'published'), THEN the rollback to depW runs
  // INLINE before the spy returns — so the epilogue sees active=depW. Pre-fix:
  // depW's worker is DELETED + a /clear cron call fires (FAIL). Post-fix: the
  // epilogue-entry re-check sees active=depW != the static deploy and SKIPS the
  // whole epilogue → depW's worker survives, no cron call (PASS).
  it('F14: a published-then-superseded static deploy must NOT delete the now-active WfP worker (flip-after-publish)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f14-flip-after-publish');
    const handle = mockCfApi();

    const cronCalls: Array<string> = [];
    const originalCron = env.CRON_SCHEDULER;
    env.CRON_SCHEDULER = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (_id: unknown) => ({
        fetch: async (req: Request) => {
          cronCalls.push(new URL(req.url).pathname);
          return Response.json({ ok: true });
        },
      }),
    } as unknown as DurableObjectNamespace;

    // Retained WfP target depW with one schedule.
    const depW = await db.createDeployment(
      env.db,
      project.id,
      JSON.stringify({
        version: 2,
        type: 'void',
        bindings: {},
        schedules: [{ name: 'nightly', cron: '0 0 * * *' }],
      }),
    );
    await db.updateDeploymentStatus(env.db, depW.id, 'failed');
    await db.markDeploymentRetained(env.db, depW.id, true);

    const depWWorker = `user-${project.slug}-${depW.id}`;
    handle.seedHostScript({ scriptName: depWWorker });
    expect(handle.state.hostScripts.has(depWWorker)).toBe(true);

    const bytes = new TextEncoder().encode('<h1>f14</h1>');
    const indexHash = HASH(0xf1401);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, indexHash, bytes);

    let deployDeploymentId: string | undefined;
    let rollbackRan = false;
    const realPublish = db.publishRoutingIfStillActive;
    const publishSpy = vi
      .spyOn(db, 'publishRoutingIfStillActive')
      .mockImplementation(async (database, projectId, deploymentId, publish) => {
        // For the static deploy's publish: run it for real FIRST (it is active
        // at this point → returns 'published'), THEN flip the active pointer to
        // depW via a rollback before returning. The epilogue runs next, against
        // the now-flipped pointer.
        if (deploymentId !== depW.id && !rollbackRan) {
          deployDeploymentId = deploymentId;
          const outcome = await realPublish(database, projectId, deploymentId, publish);
          rollbackRan = true;
          const rollbackRes = await app.fetch(
            new Request(`http://localhost/projects/${project.id}/rollback`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${user.jwt}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ deploymentId: depW.id }),
            }),
            env,
          );
          expect(rollbackRes.status).toBe(200);
          // Isolate cron calls: only the static deploy's epilogue can add them now.
          cronCalls.length = 0;
          return outcome;
        }
        return realPublish(database, projectId, deploymentId, publish);
      });

    try {
      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            manifest: v2Manifest({ type: 'spa' }),
            assetManifest: {
              '/index.html': { blake3: indexHash, md5: MD5(0xf1402), size: bytes.byteLength },
            },
            source: null,
            commit: null,
            preflight: null,
          }),
        }),
        env,
      );
      expect(res.status).toBe(200);
      // The static deploy's publish returned 'published' (it was active then).
      const done = (await readAllEvents(res)).find((e) => isEvent(e, 'done')) as unknown as
        | { published?: boolean }
        | undefined;
      expect(done?.published).toBe(true);
    } finally {
      publishSpy.mockRestore();
      env.CRON_SCHEDULER = originalCron;
    }

    // CRITICAL: the now-active rollback target's worker was NOT deleted by the
    // static deploy's stale epilogue.
    expect(handle.state.hostScripts.has(depWWorker)).toBe(true);
    const deletedDepWWorker = handle.state.recordedCalls.some(
      (c) => c.method === 'DELETE' && c.url.includes(`/scripts/${depWWorker}`),
    );
    expect(deletedDepWWorker).toBe(false);
    // The stale static deploy issued NO cron call after the rollback (its
    // clearCronScheduler would have clobbered depW's synced schedules).
    expect(cronCalls).toEqual([]);

    // active still points at the rollback target depW.
    const [proj] = await env.db
      .select({ active_deployment_id: projects.active_deployment_id })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(proj?.active_deployment_id).toBe(depW.id);
    expect(proj?.active_deployment_id).not.toBe(deployDeploymentId);
  });

  // F15 (Finding 1): the catch's `goLiveTxCommitted` recovery branch must NOT
  // re-assert the active pointer over a NEWER winner. A deploy commits live,
  // then its publish is SUPERSEDED by a rollback to depW (active=depW). The
  // deploy's own-row `markDeploymentRetained` then throws (transient pg error)
  // → control reaches the recovery branch, which pre-fix UNCONDITIONALLY ran
  // `setActiveDeployment(projectId, staleDeploy.id)` — clobbering the newer
  // winner's pointer back to the stale deploy. Worse, the stale row is
  // unpublished, so the reconciler would then republish its stale routing.
  //
  // Discriminator: drive the supersession directly through the publish seam (no
  // nested request — that deadlocks PGlite's single connection). When the
  // deploy's publish runs, the spy FLIPS the active pointer to depW (simulating
  // a concurrent rollback/deploy that won the race), publishes depW's slug
  // route, and returns 'superseded'. Then the deploy's own-row
  // markDeploymentRetained throws (transient pg error). Pre-fix: the throw hits
  // the catch's recovery branch which re-flips active back to the stale deploy
  // (FAIL). Post-fix: the own-row mark is best-effort (.catch) AND the recovery
  // re-asserts only under a lock+re-check → active stays depW, and the stale row
  // is NOT marked published so no stale routing is left for the reconciler.
  it('F15: recovery branch must not re-flip active back to a superseded deploy when markRetained throws', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f15-recovery-noreflip');
    mockCfApi();

    const originalDispatch = env.DISPATCH;
    env.DISPATCH = {
      get: () => ({ fetch: async () => Response.json({ ready: true }) }),
    } as unknown as DispatchNamespace;

    // Retained WfP winner depW (the deployment that won the race). Seed its
    // slug route so the "no stale routing left" assertion is meaningful.
    const depW = await db.createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 2, type: 'void', bindings: {} }),
    );
    await db.updateDeploymentStatus(env.db, depW.id, 'failed');
    await db.markDeploymentRetained(env.db, depW.id, true);
    const depWRoutingJson = JSON.stringify({ version: depW.id, projectId: project.id });

    const workerBytes = new TextEncoder().encode(
      "export default { fetch() { return new Response('f15'); } }",
    );
    let bin = '';
    for (let i = 0; i < workerBytes.length; i++) {
      bin += String.fromCharCode(workerBytes[i]);
    }
    const workerFiles: Record<string, string> = { 'index.js': btoa(bin) };

    let deployDeploymentId: string | undefined;
    const realPublish = db.publishRoutingIfStillActive;
    const publishSpy = vi
      .spyOn(db, 'publishRoutingIfStillActive')
      .mockImplementation(async (database, projectId, deploymentId, _publish) => {
        // The deploy's publish: simulate a concurrent winner (depW) having
        // flipped the pointer + published its routing just before this publish
        // re-checks. Return 'superseded' WITHOUT running this deploy's KV puts.
        if (deploymentId !== depW.id) {
          deployDeploymentId = deploymentId;
          await db.setActiveDeployment(database, projectId, depW.id);
          await env.ROUTING.put(project.slug, depWRoutingJson);
          return 'superseded';
        }
        return realPublish(database, projectId, deploymentId, _publish);
      });

    // Make the own-row retain mark throw ONLY for the stale deploy's row (its id
    // is captured inside the publish spy, which runs before markRetained).
    const realMarkRetained = db.markDeploymentRetained;
    const markSpy = vi
      .spyOn(db, 'markDeploymentRetained')
      .mockImplementation(async (database, deploymentId, retained) => {
        if (deploymentId === deployDeploymentId && retained === true) {
          throw new Error('transient pg error during markDeploymentRetained');
        }
        return realMarkRetained(database, deploymentId, retained);
      });

    try {
      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            manifest: v2Manifest({ type: 'void' }),
            assetManifest: {},
            source: null,
            commit: null,
            preflight: null,
            workerFiles,
          }),
        }),
        env,
      );
      // The deploy stays committed-live (200) even though its markRetained threw
      // — recovery re-affirms its OWN-row live state and emits `done`.
      expect(res.status).toBe(200);
      // The publish was superseded, so the deploy did not own routing.
      const done = (await readAllEvents(res)).find((e) => isEvent(e, 'done')) as unknown as
        | { published?: boolean }
        | undefined;
      expect(done?.published).toBe(false);
    } finally {
      publishSpy.mockRestore();
      markSpy.mockRestore();
      env.DISPATCH = originalDispatch;
    }

    expect(deployDeploymentId).toBeDefined();

    // CRITICAL: active still points at the winner depW — the recovery branch did
    // NOT re-flip it back to the superseded deploy.
    const [proj] = await env.db
      .select({ active_deployment_id: projects.active_deployment_id })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(proj?.active_deployment_id).toBe(depW.id);
    expect(proj?.active_deployment_id).not.toBe(deployDeploymentId);

    // The slug route still points at depW (no stale routing for the reconciler).
    const slugEntry = (await env.ROUTING.get(project.slug, 'json')) as { version: string };
    expect(slugEntry.version).toBe(depW.id);

    // The stale deploy's row is NOT marked routing_published (its publish was
    // superseded), so the reconciler will not treat it as healthy — and since
    // active=depW it self-excludes from the reconciler's active-row query.
    const [staleRow] = await env.db
      .select({ routing_published: deployments.routing_published })
      .from(deployments)
      .where(eq(deployments.id, deployDeploymentId!));
    expect(staleRow?.routing_published ?? false).toBe(false);
  });

  // F18: a ROLLBACK whose routing publish outcome is 'failed' must NOT touch the
  // project-keyed CronScheduler DO. Pre-fix the cron sync/clear ran in a
  // post-return block gated only on `!== 'superseded'` — which is TRUE on a
  // 'failed' publish — so a rollback whose routing never published still issued
  // a project-keyed cron /clear (or /sync), clobbering the schedules the
  // currently-active deployment owns. (The 'superseded' case was already guarded
  // pre-fix, so the discriminating case is 'failed'.)
  //
  // Discriminator: spy `publishRoutingIfStillActive` to return 'failed' for the
  // rollback target (both attempts) WITHOUT running the closure. The rollback
  // stays committed-live (200). Post-fix the cron sync/clear is INSIDE the
  // (bypassed) publish closure → cronCalls empty (PASS). Pre-fix the post-return
  // block (failed !== superseded) issued a /clear → cronCalls records it (FAIL).
  it('F18: rollback with a failed routing publish must NOT touch cron', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-rollback-cron');
    mockCfApi();

    const originalDispatch = env.DISPATCH;
    env.DISPATCH = {
      get: () => ({ fetch: async () => Response.json({ ready: true }) }),
    } as unknown as DispatchNamespace;

    const cronCalls: Array<string> = [];
    const originalCron = env.CRON_SCHEDULER;
    env.CRON_SCHEDULER = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (_id: unknown) => ({
        fetch: async (req: Request) => {
          cronCalls.push(new URL(req.url).pathname);
          return Response.json({ ok: true });
        },
      }),
    } as unknown as DurableObjectNamespace;

    // Rollback target: a retained WfP deployment with NO schedule, so the
    // pre-fix post-return cron block would issue a project-keyed /clear (which
    // needs no proxy-token resolution) — the exact harmful write on a failed
    // rollback: clearing the currently-active deployment's schedules.
    const depTarget = await db.createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 2, type: 'void', bindings: {} }),
    );
    await db.updateDeploymentStatus(env.db, depTarget.id, 'failed');
    await db.markDeploymentRetained(env.db, depTarget.id, true);

    // Force BOTH publish attempts to report 'failed' WITHOUT running the closure
    // (routing never published; cron — now inside the closure — never invoked).
    const publishSpy = vi.spyOn(db, 'publishRoutingIfStillActive').mockResolvedValue('failed');

    try {
      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/rollback`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ deploymentId: depTarget.id }),
        }),
        env,
      );
      // A failed routing publish never fails a committed-live rollback (200).
      expect(res.status).toBe(200);
    } finally {
      publishSpy.mockRestore();
      env.DISPATCH = originalDispatch;
      env.CRON_SCHEDULER = originalCron;
    }

    // The failed rollback ran NO cron sync/clear.
    expect(cronCalls).toEqual([]);
  });

  // F19: a WfP deploy whose routing publish outcome is 'failed' must NOT sync
  // the project-keyed CronScheduler DO. Pre-fix the cron sync ran in the
  // epilogue gated on `isStillActiveDeployment` — which is TRUE on a failed
  // publish (nothing superseded the deploy; the KV write merely failed) — so
  // the epilogue synced crons even though routing never published. Post-fix the
  // cron sync is inside the publish closure, which on 'failed' either threw
  // before reaching cron (real KV failure) or was never invoked (the helper
  // reported 'failed' without running it) — so cron never fires.
  //
  // Discriminator: spy `publishRoutingIfStillActive` to return 'failed' for
  // this deploy (both attempts) WITHOUT running the closure. The deploy stays
  // DB-active, so the epilogue's `isStillActiveDeployment` is true. Post-fix:
  // cron is inside the bypassed closure → cronCalls empty (PASS). Pre-fix: the
  // still-active epilogue synced cron → cronCalls records a call (FAIL).
  it('F19: WfP deploy with a failed routing publish must NOT sync cron', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f19-failed-cron');
    mockCfApi();

    const originalDispatch = env.DISPATCH;
    env.DISPATCH = {
      get: () => ({ fetch: async () => Response.json({ ready: true }) }),
    } as unknown as DispatchNamespace;

    const cronCalls: Array<string> = [];
    const originalCron = env.CRON_SCHEDULER;
    env.CRON_SCHEDULER = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (_id: unknown) => ({
        fetch: async (req: Request) => {
          cronCalls.push(new URL(req.url).pathname);
          return Response.json({ ok: true });
        },
      }),
    } as unknown as DurableObjectNamespace;

    // Force BOTH publish attempts to report 'failed' WITHOUT running the
    // closure (so routing is never published and cron — now inside the closure
    // — is never invoked by the publish path).
    const publishSpy = vi.spyOn(db, 'publishRoutingIfStillActive').mockResolvedValue('failed');

    const workerBytes = new TextEncoder().encode(
      "export default { fetch() { return new Response('f19'); } }",
    );
    let bin = '';
    for (let i = 0; i < workerBytes.length; i++) {
      bin += String.fromCharCode(workerBytes[i]);
    }
    const workerFiles: Record<string, string> = { 'index.js': btoa(bin) };

    let done: { deployment: string; published?: boolean } | undefined;
    try {
      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // WfP manifest WITH a schedule — pre-fix the still-active epilogue
            // would have synced this schedule.
            manifest: v2Manifest({
              type: 'void',
              schedules: [{ name: 'nightly', cron: '0 0 * * *' }],
            }),
            assetManifest: {},
            source: null,
            commit: null,
            preflight: null,
            workerFiles,
          }),
        }),
        env,
      );
      expect(res.status).toBe(200);
      done = (await readAllEvents(res)).find((e) => isEvent(e, 'done')) as unknown as
        | { deployment: string; published?: boolean }
        | undefined;
      expect(done).toBeDefined();
      // 'failed' publish → degraded, NOT published (healed by the reconciler).
      expect(done!.published).toBe(false);
    } finally {
      publishSpy.mockRestore();
      env.DISPATCH = originalDispatch;
      env.CRON_SCHEDULER = originalCron;
    }

    // The deploy is still DB-active (nothing superseded it), so the epilogue
    // ran — but the cron sync is inside the (failed, bypassed) publish closure,
    // so NO cron DO call was made.
    expect(cronCalls).toEqual([]);
  });

  // F20: a static deploy deletes EVERY retained WfP deployment's worker script
  // (going static serves no WfP workers), but pre-fix it left those rows
  // `retained=true` — so a row advertised a rollback target whose worker was
  // gone, and a later rollback (admitted on `retained`, routed to
  // `user-${slug}-${id}`) would route to a MISSING worker → outage. Post-fix the
  // delete loop marks each such deployment `retained=false` (under the project
  // lock-CAS) before deleting its script.
  //
  // Discriminator: deploy STATIC over a project that has a retained WfP
  // deployment depW (with a seeded live worker). Then attempt a rollback to
  // depW. Post-fix: depW's worker was deleted AND its row is `retained=false`,
  // so the rollback is rejected 400 (PASS). Pre-fix: depW stays `retained=true`
  // → the rollback is ADMITTED and would route to the deleted worker (FAIL).
  it('F20: going static unretains the WfP deployments whose workers it deletes', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f20-static-unretain');
    const handle = mockCfApi();

    // Retained WfP deployment depW with a seeded live worker script. It is NOT
    // the active deployment (a separate live deployment is active), so the
    // static deploy's delete loop will target it.
    const depW = await db.createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 2, type: 'void', bindings: {} }),
    );
    await db.updateDeploymentStatus(env.db, depW.id, 'failed');
    await db.markDeploymentRetained(env.db, depW.id, true);
    const depWWorker = `user-${project.slug}-${depW.id}`;
    handle.seedHostScript({ scriptName: depWWorker });
    expect(handle.state.hostScripts.has(depWWorker)).toBe(true);

    const bytes = new TextEncoder().encode('<h1>f20</h1>');
    const indexHash = HASH(0xf2001);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, indexHash, bytes);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manifest: v2Manifest({ type: 'spa' }),
          assetManifest: {
            '/index.html': { blake3: indexHash, md5: MD5(0xf2002), size: bytes.byteLength },
          },
          source: null,
          commit: null,
          preflight: null,
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const done = (await readAllEvents(res)).find((e) => isEvent(e, 'done')) as unknown as
      | { published?: boolean }
      | undefined;
    expect(done?.published).toBe(true);

    // depW's worker script was deleted by the static deploy.
    expect(handle.state.hostScripts.has(depWWorker)).toBe(false);

    // Post-fix: depW's row was marked retained=false (under the lock) before
    // the delete, so a rollback to it is REJECTED — it is no longer advertised
    // as a routable target whose worker is missing.
    const [depWRow] = await env.db
      .select({ retained: deployments.retained })
      .from(deployments)
      .where(eq(deployments.id, depW.id));
    expect(depWRow?.retained).toBe(false);

    const rollbackRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId: depW.id }),
      }),
      env,
    );
    expect(rollbackRes.status).toBe(400);
    const rbBody = (await rollbackRes.json()) as { error: string };
    expect(rbBody.error).toMatch(/not retained/);
  });

  it('rejects assetManifestVersion !== 2', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-bad-v');
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: { version: 3, bindings: {} }, // no assetManifestVersion
          assetManifest: {},
          source: null,
          commit: null,
          preflight: null,
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { event?: string; message?: string };
    expect(body.message).toContain('assetManifestVersion: 2');
  });

  it('rejects malformed blake3 in assetManifest', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-bad-am-b3');
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: v2Manifest({ type: 'spa' }),
          assetManifest: {
            '/x': { blake3: 'too-short', md5: MD5(1), size: 1 },
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toMatch(/blake3 must be 32 lowercase hex/);
  });

  it('rejects malformed md5 in assetManifest', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-bad-am-md5');
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: v2Manifest({ type: 'spa' }),
          assetManifest: {
            '/x': { blake3: HASH(1), md5: 'short', size: 1 },
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toMatch(/md5 must be 32 lowercase hex/);
  });

  it('rejects missing manifest', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-bad-no-mf');
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ assetManifest: {} }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  // Regression for the multi-copy base64 decode path: each `workerFiles`
  // entry used to materialize as `raw` (UTF-16) → `bin` (latin1) →
  // `Uint8Array` → `Blob`, which for a near-cap 32 MiB module pushed peak
  // residency past the 128 MiB isolate cap. The decode now uses a
  // single-allocation helper and `delete`-s each source string from the
  // parsed body before moving on. This test exercises a multi-entry
  // `workerFiles` map (the path that previously held every base64 string
  // live for the full loop) and verifies every decoded module round-trips
  // byte-for-byte through the persisted R2 bundle.
  it('decodes multi-entry workerFiles correctly (no per-entry corruption from delete-as-we-go)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-wfp-multi');
    mockCfApi();

    const originalDispatch = env.DISPATCH;
    env.DISPATCH = {
      get: () => ({
        fetch: async () => Response.json({ ready: true }),
      }),
    } as unknown as DispatchNamespace;

    try {
      // Three modules with deliberately distinct contents so a copy/dedupe
      // bug would surface as a content mismatch on at least one entry.
      const modules: Record<string, Uint8Array> = {
        'index.js': new TextEncoder().encode(
          "export default { fetch() { return new Response('a'); } }",
        ),
        'worker-1.js': new TextEncoder().encode(
          "export default { fetch() { return new Response('bb'); } }",
        ),
        'worker-2.js': new TextEncoder().encode(
          "export default { fetch() { return new Response('ccc'); } }",
        ),
      };
      const b64 = (bytes: Uint8Array): string => {
        let bin = '';
        for (let i = 0; i < bytes.length; i++) {
          bin += String.fromCharCode(bytes[i]);
        }
        return btoa(bin);
      };
      const workerFiles: Record<string, string> = {};
      for (const [name, bytes] of Object.entries(modules)) {
        workerFiles[name] = b64(bytes);
      }

      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            manifest: v2Manifest({ type: 'void' }),
            assetManifest: {},
            source: null,
            commit: null,
            preflight: null,
            workerFiles,
          }),
        }),
        env,
      );
      expect(res.status).toBe(200);
      const events = await readAllEvents(res);
      const done = events.find((e) => isEvent(e, 'done')) as unknown as
        | { deployment: string; workers: number }
        | undefined;
      expect(done).toBeDefined();
      expect(done!.workers).toBe(3);

      // Verify each persisted module's bytes match the source — this would
      // fail if `delete`-ing during iteration skipped an entry, or if the
      // single-pass decode produced wrong bytes.
      for (const [name, expected] of Object.entries(modules)) {
        const obj = await env.STATIC_ASSETS_R2.get(
          `worker-bundles/${project.id}/${done!.deployment}/${name}`,
        );
        expect(obj).not.toBeNull();
        const persisted = new Uint8Array(await obj!.arrayBuffer());
        expect(persisted.byteLength).toBe(expected.byteLength);
        expect(persisted).toEqual(expected);
      }
    } finally {
      env.DISPATCH = originalDispatch;
    }
  });

  // Body cap regression — a 32 MiB raw worker module becomes ~43 MiB
  // base64-encoded, which under the original 32 MiB cap was a 413 even
  // though the per-module limit is 32 MiB. Cap is now 64 MiB. We exercise
  // a body comfortably above the old cap and below the new one to prove
  // the regression is fixed without taking 60 MiB of test memory.
  it('accepts JSON-mode bodies larger than the legacy 32 MiB cap', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-big-body');
    mockCfApi();

    // 36 MiB of base64 worker bytes — well past the old cap (32 MiB) and
    // well under the new one (64 MiB). Random-ish content keeps the
    // gzip compressor honest.
    const rawSize = 27 * 1024 * 1024; // base64-expanded ≈ 36 MiB
    const raw = new Uint8Array(rawSize);
    for (let i = 0; i < raw.length; i++) {
      raw[i] = i & 0xff;
    }
    let bin = '';
    const chunk = 8192;
    for (let i = 0; i < raw.length; i += chunk) {
      bin += String.fromCharCode(...raw.subarray(i, Math.min(i + chunk, raw.length)));
    }
    const b64 = btoa(bin);
    expect(b64.length).toBeGreaterThan(32 * 1024 * 1024);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: v2Manifest({ type: 'void' }),
          assetManifest: {},
          workerFiles: { 'index.js': b64 },
          source: null,
          commit: null,
          preflight: null,
        }),
      }),
      env,
    );

    // We don't care whether downstream finalization succeeds — we just
    // need the body cap NOT to 413. Anything other than 413 is a pass
    // for this regression check.
    expect(res.status).not.toBe(413);
  });

  // Bug 1 — JSON static mode must not R2-head'verify carry-forward hashes
  // (they may live in KV from a prior deploy). Mirrors the multipart path
  // which writes small assets to KV via STATIC_ASSETS.
  it('static deploy succeeds when a carry-forward asset lives in KV (not R2)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-static-kv-cf');
    mockCfApi();

    // Prior deploy: small asset stored in KV (no `!` prefix in serving
    // manifest), simulating what the multipart path does for assets
    // smaller than KV_THRESHOLD. The R2 bucket is intentionally empty
    // for this hash — the asset only exists in KV.
    const kvHash = HASH(0x4101);
    const kvBytes = new TextEncoder().encode('<h1>kv-prior</h1>');
    // Stash the bytes in STATIC_ASSETS KV so the dispatch fallback
    // chain would still work in production. We don't rely on this for
    // the test assertion; we just want the prior placement to be KV.
    await env.STATIC_ASSETS.put(
      `assets/${project.id}/${kvHash}`,
      kvBytes.buffer.slice(0, kvBytes.byteLength) as ArrayBuffer,
    );

    const liveId = 'dpl_live_jm_static_kv_cf';
    const liveManifest = {
      version: 3,
      assetManifestVersion: 2,
      type: 'spa',
      bindings: {},
      assetConfig: { not_found_handling: 'single-page-application' },
    };
    const liveAssetManifest = {
      '/index.html': { hash: kvHash, size: kvBytes.byteLength },
    };
    await env.db.insert(deployments).values({
      id: liveId,
      project_id: project.id,
      status: 'live',
      manifest: JSON.stringify(liveManifest),
      asset_hashes: JSON.stringify(liveAssetManifest),
      created_at: sql`now()`,
      deployed_at: sql`now()`,
    });
    await env.db
      .update(projects)
      .set({ active_deployment_id: liveId })
      .where(eq(projects.id, project.id));
    // Prior serving manifest with NO `!` prefix → KV placement.
    await env.ROUTING.put(`manifest:${liveId}`, JSON.stringify({ '/index.html': kvHash }));

    // New deploy: declares the same hash (carried forward) plus a new
    // R2-uploaded asset. R2 bucket only has the new hash; the kvHash
    // is intentionally absent from R2.
    const newR2Hash = HASH(0x4102);
    const newR2Bytes = new TextEncoder().encode('body { color: blue }');
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, newR2Hash, newR2Bytes);

    // Sanity-check: kvHash is NOT in R2.
    const headBefore = await env.STATIC_ASSETS_R2.head(`assets/${project.id}/${kvHash}`);
    expect(headBefore).toBeNull();

    // Build a different manifest so the dedupe short-circuit doesn't
    // fire (we want the full pipeline to run).
    const newManifest = {
      ...liveManifest,
      // `redirectRules` differs from prior — forces dedupe miss.
      redirectRules: [{ source: '/old', destination: '/new', status: 301 }],
    };
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: newManifest,
          assetManifest: {
            '/index.html': { blake3: kvHash, md5: MD5(0x4103), size: kvBytes.byteLength },
            '/style.css': {
              blake3: newR2Hash,
              md5: MD5(0x4104),
              size: newR2Bytes.byteLength,
            },
          },
          source: null,
          commit: null,
          preflight: 'true',
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const done = events.find((e) => isEvent(e, 'done')) as unknown as
      | { deployment: string; assets: number }
      | undefined;
    const errEvt = events.find((e) => isEvent(e, 'error'));
    expect(errEvt).toBeUndefined();
    expect(done).toBeDefined();
    expect(done!.assets).toBe(2);

    // The new serving manifest should preserve KV placement for the
    // carry-forward hash (no `!` prefix) and write the new hash with
    // `!` (direct-to-R2 always lands in R2).
    const serving = (await env.ROUTING.get(`manifest:${done!.deployment}`, 'json')) as Record<
      string,
      string
    > | null;
    expect(serving).toEqual({
      '/index.html': kvHash, // carried forward, KV placement preserved
      '/style.css': `!${newR2Hash}`, // new this deploy, R2-prefixed
    });
  });

  // Bug 2 — JSON mode must reject `workerFiles` for static-typed manifests,
  // mirroring multipart's `worker:*` rejection. Must happen BEFORE
  // placeholder insert so the rejected request leaves no phantom row.
  it('rejects workerFiles when manifest.type is spa', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-spa-no-worker');
    const indexJs = new TextEncoder().encode('export default { fetch() {} }');
    let bin = '';
    for (let i = 0; i < indexJs.length; i++) {
      bin += String.fromCharCode(indexJs[i]);
    }
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: v2Manifest({ type: 'spa' }),
          assetManifest: {},
          workerFiles: { 'index.js': btoa(bin) },
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toMatch(/worker.*not allowed.*spa or static/);

    // No phantom placeholder row should remain — the rejection happened
    // before the precheck-and-claim transaction.
    const rows = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(rows).toHaveLength(0);
  });

  it('rejects workerFiles when manifest.type is static', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-static-no-worker');
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest: v2Manifest({ type: 'static' }),
          assetManifest: {},
          workerFiles: { 'index.js': btoa('x') },
        }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toMatch(/worker.*not allowed.*spa or static/);
  });

  // Bug 3 — A `cancelDeployment` call landing during the early-error
  // window (after placeholder insert but before manifest update) must not
  // strand the row in `canceling`. The finally-reaper must clean it up.
  it('placeholder reaper cleans up canceling rows when cancel races early-error path', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'jm-cancel-early');
    mockCfApi();

    // Patch R2.head() to flip the in-flight placeholder to `canceling`
    // BEFORE returning null — simulating a `cancelDeployment` API call
    // that lands during the asset-verify phase. R2.head() is called
    // immediately after the placeholder insert, so this races the
    // early-error path that fires when we report missing hashes.
    const originalHead = env.STATIC_ASSETS_R2.head.bind(env.STATIC_ASSETS_R2);
    let canceledOnce = false;
    env.STATIC_ASSETS_R2.head = (async (key: string) => {
      if (!canceledOnce) {
        canceledOnce = true;
        // Find the placeholder row this request just inserted.
        const rows = await env.db
          .select({ id: deployments.id, status: deployments.status })
          .from(deployments)
          .where(eq(deployments.project_id, project.id));
        if (rows.length > 0) {
          await cancelDeployment(env.db, rows[0].id, 'test cancel during asset_verify');
        }
      }
      // Return null so the request takes the missing-hash early-return
      // path. Without the reaper fix the canceled row would be stranded
      // at `canceling` with manifest=null.
      return null;
    }) as typeof env.STATIC_ASSETS_R2.head;

    try {
      const missingHash = HASH(0x9001);
      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            manifest: v2Manifest({ type: 'spa' }),
            assetManifest: {
              '/index.html': { blake3: missingHash, md5: MD5(0x9002), size: 5 },
            },
            source: null,
            commit: null,
            preflight: null,
          }),
        }),
        env,
      );
      expect(res.status).toBe(200);
      await readAllEvents(res);
    } finally {
      env.STATIC_ASSETS_R2.head = originalHead;
    }

    // After the reaper runs, the placeholder row (manifest=null) must
    // be deleted — leaving NO row in `canceling` or `pending`.
    const finalRows = await env.db
      .select({ id: deployments.id, status: deployments.status, manifest: deployments.manifest })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    for (const r of finalRows) {
      expect(['canceling', 'pending']).not.toContain(r.status);
    }
  });

  // F22 (b): a domain DELETED between a deploy's domain snapshot and its
  // post-commit publish must NOT be recreated in KV by the publish. The deploy
  // path snapshots the project's domains BEFORE the post-commit publish; the
  // publish guard re-checks only the active POINTER, not the domain set. So a
  // domain deleted in that window would, with the OLD code, be re-published from
  // the stale snapshot AND stamped `routing_published=true` → the reconciler
  // (which heals only unpublished rows) never repairs it → the deleted domain's
  // `domain:<host>` route survives forever.
  //
  // FIX: the publish closure re-reads the active domain set UNDER THE LOCK (via
  // the lock-tx handle), so a domain deleted before the publisher acquires the
  // lock is simply absent → not republished. The delete handler now takes the
  // SAME project lock, so the two serialize.
  //
  // Discriminator (PGlite single-connection → sequential seam): park the deploy's
  // publisher at a barrier BEFORE it acquires the helper lock; while parked,
  // DELETE the domain (acquires + releases the lock, removes row + KV key); then
  // release the deploy → its publisher acquires the lock, re-reads domains (the
  // deleted one is gone), and does NOT recreate `domain:<host>`.
  it('F22: a domain deleted between a deploy snapshot and its publish must NOT be recreated in KV', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f22-del-domain');
    mockCfApi();

    // Active custom domain with a pre-existing (stale) KV route.
    await env.db.insert(domains).values({
      id: 'dom_f22del',
      project_id: project.id,
      hostname: 'del.example.com',
      cf_hostname_id: 'ch-f22del',
      status: 'active',
    });
    await env.ROUTING.put('domain:del.example.com', JSON.stringify({ version: 'stale' }));

    const bytes = new TextEncoder().encode('<h1>f22</h1>');
    const indexHash = HASH(0xf2201);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, indexHash, bytes);

    let releaseDeploy: () => void = () => {};
    const deployHold = new Promise<void>((r) => {
      releaseDeploy = r;
    });
    let deployReached: (() => void) | undefined;
    const deployReachedPublish = new Promise<void>((r) => {
      deployReached = r;
    });
    let deployDeploymentId: string | undefined;
    const realPublish = db.publishRoutingIfStillActive;
    const publishSpy = vi
      .spyOn(db, 'publishRoutingIfStillActive')
      .mockImplementation(async (database, projectId, deploymentId, publish) => {
        // Park the deploy's publisher BEFORE it acquires the helper lock, so the
        // delete below can take the project lock, remove the domain, and release
        // before the publisher re-reads the active domain set under the lock.
        if (deployDeploymentId === undefined) {
          deployDeploymentId = deploymentId;
          deployReached?.();
          await deployHold;
        }
        return realPublish(database, projectId, deploymentId, publish);
      });

    try {
      const deployPromise = app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            manifest: v2Manifest({ type: 'spa' }),
            assetManifest: {
              '/index.html': { blake3: indexHash, md5: MD5(0xf2202), size: bytes.byteLength },
            },
            source: null,
            commit: null,
            preflight: null,
          }),
        }),
        env,
      );
      await deployReachedPublish;

      // Delete the domain while the deploy publisher is parked.
      const delRes = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/domains/dom_f22del`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${user.jwt}` },
        }),
        env,
      );
      expect(delRes.status).toBe(200);

      releaseDeploy();
      const res = await deployPromise;
      expect(res.status).toBe(200);
      await readAllEvents(res);
    } finally {
      publishSpy.mockRestore();
    }

    // The domain row is gone, and its KV route was NOT recreated by the publish.
    const [row] = await env.db.select().from(domains).where(eq(domains.id, 'dom_f22del'));
    expect(row).toBeUndefined();
    const domainRoute = await env.ROUTING.get('domain:del.example.com');
    expect(domainRoute).toBeNull();
  });

  // F22 (a): a domain ACTIVATED between a deploy's domain snapshot and its
  // post-commit publish must be routed to the NEW deployment, not stranded on
  // the old one. The OLD code published from the pre-publish snapshot (which saw
  // the domain as `pending`), so the newly-active domain got NO route to the new
  // deployment.
  //
  // FIX: the publish closure re-reads the active domain set UNDER THE LOCK, so a
  // domain flipped to `active` before the publisher acquires the lock is picked
  // up and routed.
  //
  // Discriminator: park the publisher BEFORE the lock; while parked, flip the
  // domain row `pending`→`active` (the committed result of a concurrent
  // activation); release → the publisher re-reads under the lock, sees the now-
  // active domain, and writes its `domain:<host>` route to the new deployment.
  it('F22: a domain activated between a deploy snapshot and its publish is routed to the new deployment', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f22-act-domain');
    mockCfApi();

    // Domain starts PENDING (not in the pre-publish snapshot's active set).
    await env.db.insert(domains).values({
      id: 'dom_f22act',
      project_id: project.id,
      hostname: 'act.example.com',
      cf_hostname_id: 'ch-f22act',
      status: 'pending',
    });

    const bytes = new TextEncoder().encode('<h1>f22a</h1>');
    const indexHash = HASH(0xf22a1);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, indexHash, bytes);

    let releaseDeploy: () => void = () => {};
    const deployHold = new Promise<void>((r) => {
      releaseDeploy = r;
    });
    let deployReached: (() => void) | undefined;
    const deployReachedPublish = new Promise<void>((r) => {
      deployReached = r;
    });
    let deployDeploymentId: string | undefined;
    const realPublish = db.publishRoutingIfStillActive;
    const publishSpy = vi
      .spyOn(db, 'publishRoutingIfStillActive')
      .mockImplementation(async (database, projectId, deploymentId, publish) => {
        if (deployDeploymentId === undefined) {
          deployDeploymentId = deploymentId;
          deployReached?.();
          await deployHold;
        }
        return realPublish(database, projectId, deploymentId, publish);
      });

    try {
      const deployPromise = app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            manifest: v2Manifest({ type: 'spa' }),
            assetManifest: {
              '/index.html': { blake3: indexHash, md5: MD5(0xf22a2), size: bytes.byteLength },
            },
            source: null,
            commit: null,
            preflight: null,
          }),
        }),
        env,
      );
      await deployReachedPublish;

      // The concurrent activation's committed effect: the row is now `active`.
      await env.db.update(domains).set({ status: 'active' }).where(eq(domains.id, 'dom_f22act'));

      releaseDeploy();
      const res = await deployPromise;
      expect(res.status).toBe(200);
      await readAllEvents(res);
    } finally {
      publishSpy.mockRestore();
    }

    // The newly-active domain is routed to the NEW deployment, not stranded.
    const domainRoute = (await env.ROUTING.get('domain:act.example.com', 'json')) as {
      version: string;
    } | null;
    expect(domainRoute).not.toBeNull();
    expect(domainRoute!.version).toBe(deployDeploymentId);
  });

  // F23 (REGRESSION guard from the F20 fix): a static deploy's cleanup loop marks
  // every non-active retained candidate `retained=false` before deleting its WfP
  // worker. `getRetainedDeploymentsExcluding` is NOT type-filtered, so a prior
  // STATIC/SPA candidate (no worker; a 404 no-op delete) was ALSO unretained →
  // rollback later rejects it as `not retained` even though its static assets +
  // manifest still live within `STATIC_RETENTION_LIMIT`.
  //
  // FIX: the loop derives each candidate's serving type from its manifest and
  // SKIPS the unretain + worker-delete for `static`/`spa` candidates, leaving
  // them to the static retention eviction pass.
  //
  // Both assertions (the second guards against reopening F20):
  //   - a prior STATIC/SPA deployment stays `retained=true` and is a valid
  //     rollback target.
  //   - a prior WfP deployment whose worker IS deleted is `retained=false` and is
  //     rejected by rollback.
  it('F23: a static deploy must leave a prior static/spa deployment retained + rollbackable, while still unretaining a WfP deployment whose worker it deletes', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f23-static-cleanup');
    const handle = mockCfApi();

    // Prior STATIC/SPA retained deployment (no worker) — must SURVIVE the cleanup.
    const depS = await db.createDeployment(
      env.db,
      project.id,
      JSON.stringify({
        version: 2,
        type: 'spa',
        assetConfig: { not_found_handling: 'single-page-application' },
      }),
    );
    await db.updateDeploymentStatus(env.db, depS.id, 'failed');
    await db.markDeploymentRetained(env.db, depS.id, true);

    // Prior WfP retained deployment (with a worker) — must be UNRETAINED + its
    // worker deleted (guards against reopening F20).
    const depW = await db.createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 2, type: 'void', bindings: {} }),
    );
    await db.updateDeploymentStatus(env.db, depW.id, 'failed');
    await db.markDeploymentRetained(env.db, depW.id, true);
    const depWWorker = `user-${project.slug}-${depW.id}`;
    handle.seedHostScript({ scriptName: depWWorker });

    const bytes = new TextEncoder().encode('<h1>f23</h1>');
    const indexHash = HASH(0xf2301);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, indexHash, bytes);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manifest: v2Manifest({ type: 'spa' }),
          assetManifest: {
            '/index.html': { blake3: indexHash, md5: MD5(0xf2302), size: bytes.byteLength },
          },
          source: null,
          commit: null,
          preflight: null,
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await readAllEvents(res);

    // The static/spa candidate stays retained...
    const [sRow] = await env.db
      .select({ retained: deployments.retained })
      .from(deployments)
      .where(eq(deployments.id, depS.id));
    expect(sRow?.retained).toBe(true);
    // ...and is a valid rollback target.
    const rollbackS = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId: depS.id }),
      }),
      env,
    );
    expect(rollbackS.status).toBe(200);

    // The WfP candidate's worker was deleted, the row is unretained (F20 guard)...
    expect(handle.state.hostScripts.has(depWWorker)).toBe(false);
    const [wRow] = await env.db
      .select({ retained: deployments.retained })
      .from(deployments)
      .where(eq(deployments.id, depW.id));
    expect(wRow?.retained).toBe(false);
    // ...and rollback rejects it as not retained.
    const rollbackW = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId: depW.id }),
      }),
      env,
    );
    expect(rollbackW.status).toBe(400);
    expect(((await rollbackW.json()) as { error: string }).error).toMatch(/not retained/);
  });

  // F26: the static retention eviction loop computes `toEvict` from the ORIGINAL
  // pre-skip `retained` snapshot and evicts each candidate's `manifest:<id>` +
  // assets + marks `retained=false` with NO per-candidate active re-check. So a
  // deployment that a concurrent rollback makes active DURING the static deploy's
  // cleanup (after the epilogue-entry active check, before the eviction loop) can
  // still be evicted here if it sits beyond `STATIC_RETENTION_LIMIT - 1` in the
  // snapshot → breaks the now-active deployment's static serving / future
  // rollback.
  //
  // FIX: add the same per-candidate active re-check (project-lock CAS) the
  // worker-delete loop uses before each manifest/asset eviction — skip the
  // candidate if it is now the active deployment.
  //
  // Discriminator: seed STATIC_RETENTION_LIMIT prior retained static deployments
  // so the OLDEST falls into `toEvict`. Spy on `getRetainedDeploymentsExcluding`
  // (called once, AFTER the epilogue-entry active check passes and BEFORE both
  // cleanup loops) to flip the active pointer to that oldest candidate (the
  // committed effect of a concurrent rollback) right inside the F26 window.
  // Pre-fix: its `manifest:<id>` is deleted + `retained=false` (FAIL). Post-fix:
  // the per-candidate re-check sees it active and SKIPS it.
  it('F26: a deployment a concurrent rollback makes active during static cleanup must NOT be evicted even when beyond the retention limit', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f26-evict-active');
    mockCfApi();

    // STATIC_RETENTION_LIMIT (100) prior retained static deployments. The OLDEST
    // (created first → last in desc(created_at) order) lands in
    // `toEvict = retained.slice(99)`. Seed them with staggered created_at so the
    // ordering is deterministic.
    const RETENTION_LIMIT = 100;
    const priorIds: Array<string> = [];
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < RETENTION_LIMIT; i++) {
      const id = `dpl_f26_${i.toString().padStart(3, '0')}`;
      priorIds.push(id);
      rows.push({
        id,
        project_id: project.id,
        status: 'failed',
        retained: true,
        manifest: JSON.stringify({
          version: 2,
          type: 'spa',
          assetConfig: { not_found_handling: 'single-page-application' },
        }),
        // Dated YESTERDAY so they do not count toward today's deploy quota
        // (`countUserDeploymentsToday` filters `created_at >= CURRENT_DATE`),
        // while still being retained rollback candidates. Oldest first: i=0 is
        // the earliest timestamp → last in desc order → in toEvict.
        created_at: sql`now() - interval '1 day' - (${RETENTION_LIMIT - i} || ' seconds')::interval`,
        deployed_at: sql`now() - interval '1 day' - (${RETENTION_LIMIT - i} || ' seconds')::interval`,
      });
    }
    await env.db.insert(deployments).values(rows as never);
    const oldestId = priorIds[0]; // the toEvict candidate we will make active
    // Seed its serving manifest so the "manifest survives" assertion is meaningful.
    await env.ROUTING.put(
      `manifest:${oldestId}`,
      JSON.stringify({ '/index.html': `!${HASH(0xf2601)}` }),
    );

    const bytes = new TextEncoder().encode('<h1>f26</h1>');
    const indexHash = HASH(0xf2602);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, indexHash, bytes);

    // Flip active → the oldest toEvict candidate at the exact F26 window: when the
    // static deploy's epilogue calls getRetainedDeploymentsExcluding (after its
    // own active-check passed, before both cleanup loops). In-process, no nested
    // tx held at this point.
    const realGet = db.getRetainedDeploymentsExcluding;
    let flipped = false;
    const getSpy = vi
      .spyOn(db, 'getRetainedDeploymentsExcluding')
      .mockImplementation(async (database, projectId, excludeId) => {
        const retained = await realGet(database, projectId, excludeId);
        if (!flipped) {
          flipped = true;
          // Simulate a concurrent rollback committing: the oldest candidate is
          // now the active deployment.
          await db.setActiveDeployment(database, projectId, oldestId);
        }
        return retained;
      });

    try {
      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            manifest: v2Manifest({ type: 'spa' }),
            assetManifest: {
              '/index.html': { blake3: indexHash, md5: MD5(0xf2603), size: bytes.byteLength },
            },
            source: null,
            commit: null,
            preflight: null,
          }),
        }),
        env,
      );
      expect(res.status).toBe(200);
      await readAllEvents(res);
    } finally {
      getSpy.mockRestore();
    }

    expect(flipped).toBe(true);
    // The now-active candidate is still active...
    const [proj] = await env.db
      .select({ active_deployment_id: projects.active_deployment_id })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(proj?.active_deployment_id).toBe(oldestId);
    // ...its serving manifest was NOT evicted...
    const manifestRoute = await env.ROUTING.get(`manifest:${oldestId}`);
    expect(manifestRoute).not.toBeNull();
    // ...and it remains retained (still a valid rollback target).
    const [oldRow] = await env.db
      .select({ retained: deployments.retained })
      .from(deployments)
      .where(eq(deployments.id, oldestId));
    expect(oldRow?.retained).toBe(true);
  });
});

/**
 * Regression: CF's documented `assets-upload-session` shape is
 * `{ <path>: { hash, size } }`. The framework CLI now emits v2 manifest
 * entries (`{ blake3, md5, size, hash }`) — `hash` is a deprecated alias
 * of `blake3` that keeps existing structural typing happy. The platform
 * propagates the manifest mostly verbatim through the pipeline, so a
 * defensive normalizer at the CF API boundary must strip every field
 * that isn't `hash` or `size` before the body hits CF.
 */
describe('CF asset-upload-session body never carries v2 manifest extras', () => {
  function findAssetSessionBody(fetchMock: ReturnType<typeof mockCfApi>): {
    manifest: Record<string, Record<string, unknown>>;
  } {
    const calls = fetchMock.mock.calls as Array<[unknown, RequestInit | undefined]>;
    const sessionCall = calls.find(([input]) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      return url.includes('/assets-upload-session');
    });
    if (!sessionCall) {
      throw new Error('expected at least one assets-upload-session call');
    }
    const [, init] = sessionCall;
    const raw = typeof init?.body === 'string' ? init.body : '';
    return JSON.parse(raw) as { manifest: Record<string, Record<string, unknown>> };
  }

  it('JSON-mode WfP deploy ships only {hash, size} per entry to CF', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cf-strip-json');
    const fetchMock = mockCfApi();

    const assetBytes = new TextEncoder().encode('export const x = 1;');
    const assetHash = HASH(0xfeed);
    await stageAssetInR2(env.STATIC_ASSETS_R2, project.id, assetHash, assetBytes);

    const originalDispatch = env.DISPATCH;
    env.DISPATCH = {
      get: () => ({
        fetch: async () => Response.json({ ready: true }),
      }),
    } as unknown as DispatchNamespace;

    try {
      const indexJs = new TextEncoder().encode(
        "export default { fetch() { return new Response('ok'); } }",
      );
      let bin = '';
      for (let i = 0; i < indexJs.length; i++) {
        bin += String.fromCharCode(indexJs[i]);
      }
      const indexJsB64 = btoa(bin);

      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            manifest: { version: 3, assetManifestVersion: 2, bindings: {}, type: 'void' },
            // v2 entries — `blake3` and `md5` MUST be stripped before
            // reaching CF.
            assetManifest: {
              '/static/x.js': {
                blake3: assetHash,
                md5: MD5(0xfeee),
                size: assetBytes.byteLength,
              },
            },
            source: null,
            commit: null,
            preflight: null,
            workerFiles: { 'index.js': indexJsB64 },
          }),
        }),
        env,
      );
      expect(res.status).toBe(200);
      const events = await readAllEvents(res);
      expect(events.find((e) => isEvent(e, 'done'))).toBeDefined();

      const body = findAssetSessionBody(fetchMock);
      // Every entry must be exactly { hash, size } — no blake3, md5,
      // or other fields.
      for (const [path, entry] of Object.entries(body.manifest)) {
        expect(typeof entry.hash).toBe('string');
        expect(typeof entry.size).toBe('number');
        expect(Object.keys(entry).sort()).toEqual(['hash', 'size']);
        expect(entry).not.toHaveProperty('blake3');
        expect(entry).not.toHaveProperty('md5');
        // sanity: at least one entry should be the asset we declared
        if (path === '/static/x.js') {
          expect(entry.hash).toBe(assetHash);
          expect(entry.size).toBe(assetBytes.byteLength);
        }
      }
    } finally {
      env.DISPATCH = originalDispatch;
    }
  });
});
