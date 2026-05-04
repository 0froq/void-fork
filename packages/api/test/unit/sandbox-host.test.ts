import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiEnv } from '../../src/env.ts';
import {
  buildDurableObjectUploadMigrations,
  buildSandboxUploadBindings,
  buildSandboxUploadContainers,
} from '../../src/routes/deploy.ts';
import { mockCfApi, type MockCfApiHandle } from '../integration/helpers.ts';

// ---------------------------------------------------------------------------
// Mock the db module so unit tests don't touch a real Postgres.
//
// `provisionSandboxHost` needs:
//   - `getProject(db, id)` returning a fixture project (or null).
//   - `db.transaction(cb)` invoking `cb(tx)` where `tx` exposes:
//       * `tx.execute(sql)`           — the FOR UPDATE row lock
//       * `tx.select().from(...).where(...).limit(...)` — resources lookup
//       * `tx.insert(resources).values(...).onConflictDoUpdate(...)` — UPSERT
//
// The mock builds a chainable proxy where `select` returns a thenable that
// resolves to a configurable row array, and `insert` records every UPSERT.
// ---------------------------------------------------------------------------

interface ResourceRow {
  id: string;
  project_id: string;
  type: string;
  cf_id: string;
  binding_name: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface DbState {
  project: {
    id: string;
    user_id: string;
    slug: string;
    type: 'void' | 'spa' | 'static' | 'framework';
    active_deployment_id: string | null;
    websocket_version: number;
    status: 'active' | 'deleting';
    created_at: string;
  } | null;
  resourceRows: Array<ResourceRow>;
  inserts: Array<{ values: Record<string, unknown>; conflict?: { set: Record<string, unknown> } }>;
  txExecuteCalls: Array<unknown>;
}

const dbState: DbState = {
  project: null,
  resourceRows: [],
  inserts: [],
  txExecuteCalls: [],
};

function resetDbState(): void {
  dbState.project = {
    id: 'proj_test',
    user_id: 'user_test',
    slug: 'demo',
    type: 'void',
    active_deployment_id: null,
    websocket_version: 0,
    status: 'active',
    created_at: new Date().toISOString(),
  };
  dbState.resourceRows = [];
  dbState.inserts = [];
  dbState.txExecuteCalls = [];
}

function buildMockTx(): unknown {
  const tx: Record<string, unknown> = {};

  tx.execute = vi.fn(async (q: unknown) => {
    dbState.txExecuteCalls.push(q);
    return { rows: [] };
  });

  tx.select = () => ({
    from: () => ({
      where: () => ({
        limit: async () => dbState.resourceRows,
      }),
    }),
  });

  tx.insert = () => ({
    values: (vals: Record<string, unknown>) => {
      const captured: {
        values: Record<string, unknown>;
        conflict?: { set: Record<string, unknown> };
      } = {
        values: vals,
      };
      dbState.inserts.push(captured);
      return {
        onConflictDoUpdate: async (cfg: { set: Record<string, unknown> }) => {
          captured.conflict = { set: cfg.set };
          return [];
        },
      };
    },
  });

  return tx;
}

vi.mock('../../src/db.ts', () => ({
  getProject: vi.fn(async (_db: unknown, id: string) => {
    if (!dbState.project || dbState.project.id !== id) {
      return null;
    }
    return dbState.project;
  }),
}));

import { CloudflareApiError } from '../../src/provisioning/cloudflare-api.ts';
import { deleteContainerApplicationIdempotent } from '../../src/provisioning/containers.ts';
// Import sandbox-host AFTER the db mock is registered.
import {
  ProjectDeletingError,
  fetchScriptMigrationTag,
  provisionSandboxHost,
  putSandboxHostScript,
} from '../../src/provisioning/sandbox-host.ts';

// Build a stub `db` object with a synchronous `transaction(cb)` that invokes
// the callback with a fresh tx. Cast to the platform `Db` type for the helper.
const stubDb = {
  transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => {
    return cb(buildMockTx());
  },
} as unknown as import('../../src/db.ts').Db;

const ENV = {
  CF_ACCOUNT_ID: 'acct-test',
  CF_API_TOKEN: 'token-test',
  DISPATCH_NAMESPACE: 'void-users',
} as unknown as ApiEnv['Bindings'];

const PROJECT_ID = 'proj_test';
const SLUG = 'demo';
const HOST_SCRIPT_NAME = `do-host-${SLUG}`;
const CONTAINER_NAME = 'void-sandbox';
const CONTAINER_APP_NAME = `${PROJECT_ID}-${CONTAINER_NAME}`.toLowerCase().replaceAll('_', '-');
const HOST_NAMESPACE_ID = `ns_${HOST_SCRIPT_NAME}_Sandbox`;
const HOST_MIGRATION_TAG = 'void-sandbox-host-v1';

const DESIRED_IMAGE = 'registry.cloudflare.com/sandbox:1.0.0';
const DESIRED_INSTANCE_TYPE = 'lite';
const DESIRED_MAX_INSTANCES = 20;

describe('provisionSandboxHost', () => {
  let cf: MockCfApiHandle;

  beforeEach(() => {
    resetDbState();
    cf = mockCfApi();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('1. no existing host: GETs migration_tag, PUTs host with self-binding + initial migrations + bundle, GETs bindings, POSTs container, UPSERTs row', async () => {
    const info = await provisionSandboxHost(
      ENV,
      stubDb,
      PROJECT_ID,
      SLUG,
      CONTAINER_NAME,
      DESIRED_IMAGE,
      DESIRED_INSTANCE_TYPE,
      DESIRED_MAX_INSTANCES,
    );

    expect(info).toEqual({
      scriptName: HOST_SCRIPT_NAME,
      namespaceId: HOST_NAMESPACE_ID,
      containerApplicationId: `app_${CONTAINER_APP_NAME}`,
    });

    // Ordering: GET migration_tag (fetchScriptMigrationTag) -> PUT host -> GET bindings -> POST container.
    cf.expectCallOrder(
      { method: 'GET', url: `/scripts/${HOST_SCRIPT_NAME}` },
      { method: 'PUT', url: `/scripts/${HOST_SCRIPT_NAME}` },
      { method: 'GET', url: `/scripts/${HOST_SCRIPT_NAME}/bindings` },
      { method: 'POST', url: '/containers/applications' },
    );

    // Host script PUT recorded with self-binding + initial migrations + bundle.
    const host = cf.state.hostScripts.get(HOST_SCRIPT_NAME);
    expect(host).toBeDefined();
    expect(host!.migration_tag).toBe(HOST_MIGRATION_TAG);
    expect(host!.classes.get('Sandbox')).toBe(HOST_NAMESPACE_ID);
    // Self-binding present and resolved to the minted namespace_id (used by
    // findDurableObjectNamespaceId on the bindings endpoint).
    const selfBinding = host!.bindings.find(
      (b) => b.type === 'durable_object_namespace' && b.name === 'SANDBOX',
    );
    expect(selfBinding).toBeDefined();
    expect(selfBinding!.class_name).toBe('Sandbox');
    expect(selfBinding!.namespace_id).toBe(HOST_NAMESPACE_ID);
    // Bundled bytes were sent (FormData multipart body).
    const hostPut = cf.state.recordedCalls.find(
      (c) => c.method === 'PUT' && c.url.includes(`/scripts/${HOST_SCRIPT_NAME}`),
    );
    expect(hostPut?.body).toBe('[FormData]');

    // Container app POSTed against the minted namespace.
    const app = cf.state.containerApps.get(`app_${CONTAINER_APP_NAME}`);
    expect(app).toBeDefined();
    expect(app!.durable_objects.namespace_id).toBe(HOST_NAMESPACE_ID);
    expect(app!.configuration.image).toBe(DESIRED_IMAGE);

    // UPSERT row written with the natural key + metadata.
    expect(dbState.inserts).toHaveLength(1);
    const upsert = dbState.inserts[0]!;
    expect(upsert.values).toMatchObject({
      project_id: PROJECT_ID,
      type: 'container',
      cf_id: `app_${CONTAINER_APP_NAME}`,
      binding_name: CONTAINER_NAME,
      metadata: { namespaceId: HOST_NAMESPACE_ID, hostScriptName: HOST_SCRIPT_NAME },
    });
    expect(upsert.conflict?.set).toMatchObject({
      cf_id: `app_${CONTAINER_APP_NAME}`,
      metadata: { namespaceId: HOST_NAMESPACE_ID, hostScriptName: HOST_SCRIPT_NAME },
    });
  });

  it('2. existing valid host (cache hit, no drift): exactly one always-PUT host (no migrations rotation), includes containers signal, no namespace lookup, no container POST/DELETE/PATCH', async () => {
    cf.seedHostScript({
      scriptName: HOST_SCRIPT_NAME,
      migrationTag: HOST_MIGRATION_TAG,
      classes: { Sandbox: HOST_NAMESPACE_ID },
      bindings: [
        {
          type: 'durable_object_namespace',
          name: 'SANDBOX',
          class_name: 'Sandbox',
          namespace_id: HOST_NAMESPACE_ID,
        },
      ],
    });
    cf.seedContainerApp({
      name: CONTAINER_APP_NAME,
      namespaceId: HOST_NAMESPACE_ID,
      image: DESIRED_IMAGE,
      instanceType: DESIRED_INSTANCE_TYPE,
      maxInstances: DESIRED_MAX_INSTANCES,
    });
    dbState.resourceRows = [
      {
        id: 'res_existing',
        project_id: PROJECT_ID,
        type: 'container',
        cf_id: `app_${CONTAINER_APP_NAME}`,
        binding_name: CONTAINER_NAME,
        metadata: { namespaceId: HOST_NAMESPACE_ID, hostScriptName: HOST_SCRIPT_NAME },
        created_at: new Date().toISOString(),
      },
    ];

    // Capture the always-PUT host body so we can assert it omits `migrations`
    // (tag preserved → no namespace rotation) and includes `containers` so
    // cross-script DO bindings on the user worker PUT will be accepted.
    let capturedHostPutMetadata: Record<string, unknown> | null = null;
    const realFetch = global.fetch;
    global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request | URL).toString();
      if (
        init?.method === 'PUT' &&
        url.includes(`/scripts/${HOST_SCRIPT_NAME}`) &&
        init.body instanceof FormData
      ) {
        const meta = init.body.get('metadata');
        if (meta instanceof Blob) {
          capturedHostPutMetadata = JSON.parse(await meta.text());
        }
      }
      return (realFetch as typeof fetch)(input as RequestInfo | URL, init);
    }) as typeof fetch;

    const info = await provisionSandboxHost(
      ENV,
      stubDb,
      PROJECT_ID,
      SLUG,
      CONTAINER_NAME,
      DESIRED_IMAGE,
      DESIRED_INSTANCE_TYPE,
      DESIRED_MAX_INSTANCES,
    );
    expect(info).toEqual({
      scriptName: HOST_SCRIPT_NAME,
      namespaceId: HOST_NAMESPACE_ID,
      containerApplicationId: `app_${CONTAINER_APP_NAME}`,
    });

    // Exactly one host PUT — the unconditional always-PUT at the top of
    // provisionSandboxHost. Body OMITS migrations (tag preserved, no
    // namespace rotation) and INCLUDES the containers capability marker.
    const hostPuts = cf.state.recordedCalls.filter(
      (c) => c.method === 'PUT' && c.url.includes(`/scripts/${HOST_SCRIPT_NAME}`),
    );
    expect(hostPuts).toHaveLength(1);
    expect(capturedHostPutMetadata).not.toBeNull();
    expect(capturedHostPutMetadata).not.toHaveProperty('migrations');
    expect(capturedHostPutMetadata!.containers).toEqual([{ class_name: 'Sandbox' }]);
    // Tag was preserved on the seeded host (no rotation).
    expect(cf.state.hostScripts.get(HOST_SCRIPT_NAME)!.migration_tag).toBe(HOST_MIGRATION_TAG);
    expect(cf.state.hostScripts.get(HOST_SCRIPT_NAME)!.classes.get('Sandbox')).toBe(
      HOST_NAMESPACE_ID,
    );

    // No container POST/DELETE/PATCH (config matches).
    expect(
      cf.state.recordedCalls.some(
        (c) => c.method === 'POST' && c.url.endsWith('/containers/applications'),
      ),
    ).toBe(false);
    expect(
      cf.state.recordedCalls.some(
        (c) => c.method === 'PATCH' && c.url.includes('/containers/applications/'),
      ),
    ).toBe(false);
    expect(
      cf.state.recordedCalls.some(
        (c) => c.method === 'DELETE' && c.url.includes('/containers/applications/'),
      ),
    ).toBe(false);
    // No UPSERT into resources because cached fast path returned.
    expect(dbState.inserts).toHaveLength(0);
  });

  it('3. existing valid host but container config drift (image change): exactly one always-PUT host (no migrations rotation) + container PATCH + rollout', async () => {
    cf.seedHostScript({
      scriptName: HOST_SCRIPT_NAME,
      migrationTag: HOST_MIGRATION_TAG,
      classes: { Sandbox: HOST_NAMESPACE_ID },
      bindings: [
        {
          type: 'durable_object_namespace',
          name: 'SANDBOX',
          class_name: 'Sandbox',
          namespace_id: HOST_NAMESPACE_ID,
        },
      ],
    });
    cf.seedContainerApp({
      name: CONTAINER_APP_NAME,
      namespaceId: HOST_NAMESPACE_ID,
      image: 'registry.cloudflare.com/sandbox:0.9.0', // stale
      instanceType: DESIRED_INSTANCE_TYPE,
      maxInstances: DESIRED_MAX_INSTANCES,
    });
    dbState.resourceRows = [
      {
        id: 'res_existing',
        project_id: PROJECT_ID,
        type: 'container',
        cf_id: `app_${CONTAINER_APP_NAME}`,
        binding_name: CONTAINER_NAME,
        metadata: { namespaceId: HOST_NAMESPACE_ID, hostScriptName: HOST_SCRIPT_NAME },
        created_at: new Date().toISOString(),
      },
    ];

    let capturedHostPutMetadata: Record<string, unknown> | null = null;
    const realFetch = global.fetch;
    global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request | URL).toString();
      if (
        init?.method === 'PUT' &&
        url.includes(`/scripts/${HOST_SCRIPT_NAME}`) &&
        init.body instanceof FormData
      ) {
        const meta = init.body.get('metadata');
        if (meta instanceof Blob) {
          capturedHostPutMetadata = JSON.parse(await meta.text());
        }
      }
      return (realFetch as typeof fetch)(input as RequestInfo | URL, init);
    }) as typeof fetch;

    await provisionSandboxHost(
      ENV,
      stubDb,
      PROJECT_ID,
      SLUG,
      CONTAINER_NAME,
      DESIRED_IMAGE, // different image
      DESIRED_INSTANCE_TYPE,
      DESIRED_MAX_INSTANCES,
    );

    // Exactly one host PUT — the unconditional always-PUT, with migrations
    // OMITTED (no rotation) and the containers capability marker present.
    const hostPuts = cf.state.recordedCalls.filter(
      (c) => c.method === 'PUT' && c.url.includes(`/scripts/${HOST_SCRIPT_NAME}`),
    );
    expect(hostPuts).toHaveLength(1);
    expect(capturedHostPutMetadata).not.toBeNull();
    expect(capturedHostPutMetadata).not.toHaveProperty('migrations');
    expect(capturedHostPutMetadata!.containers).toEqual([{ class_name: 'Sandbox' }]);
    // Tag preserved.
    expect(cf.state.hostScripts.get(HOST_SCRIPT_NAME)!.migration_tag).toBe(HOST_MIGRATION_TAG);

    // PATCH then rollout.
    cf.expectCallOrder(
      { method: 'PATCH', url: `/containers/applications/app_${CONTAINER_APP_NAME}` },
      { method: 'POST', url: `/containers/applications/app_${CONTAINER_APP_NAME}/rollouts` },
    );
    // Container image now reflects desired.
    expect(cf.state.containerApps.get(`app_${CONTAINER_APP_NAME}`)!.configuration.image).toBe(
      DESIRED_IMAGE,
    );
    // No UPSERT into resources (cached fast path returned after reconcile).
    expect(dbState.inserts).toHaveLength(0);
  });

  it('4. existing host record but no host script in CF: always-PUT recreates the host with initial migrations; cached fast path then reconciles container drift (PATCH+rollout)', async () => {
    // No host script in CF (fetchScriptMigrationTag returns null). A container
    // app already exists bound to what the always-PUT will mint — this is the
    // post-host-PUT-pre-resource-UPSERT replay shape after an external host
    // delete. Image is stale to exercise the drift-reconcile branch.
    //
    // After always-PUT, the freshly-minted SANDBOX namespace_id equals
    // `HOST_NAMESPACE_ID` (deterministic in the mock from scriptName +
    // className) which matches the cached metadata, so the cached fast path
    // succeeds and reconciles drift via PATCH+rollout instead of falling
    // through to create-or-recover.
    cf.seedContainerApp({
      name: CONTAINER_APP_NAME,
      namespaceId: HOST_NAMESPACE_ID, // same namespace the always-PUT will mint
      image: 'registry.cloudflare.com/sandbox:0.5.0', // stale → triggers PATCH+rollout
      instanceType: DESIRED_INSTANCE_TYPE,
      maxInstances: DESIRED_MAX_INSTANCES,
    });
    dbState.resourceRows = [
      {
        id: 'res_existing',
        project_id: PROJECT_ID,
        type: 'container',
        cf_id: `app_${CONTAINER_APP_NAME}`,
        binding_name: CONTAINER_NAME,
        metadata: { namespaceId: HOST_NAMESPACE_ID, hostScriptName: HOST_SCRIPT_NAME },
        created_at: new Date().toISOString(),
      },
    ];

    await provisionSandboxHost(
      ENV,
      stubDb,
      PROJECT_ID,
      SLUG,
      CONTAINER_NAME,
      DESIRED_IMAGE,
      DESIRED_INSTANCE_TYPE,
      DESIRED_MAX_INSTANCES,
    );

    // Order: fetchScriptMigrationTag GET → always-PUT host → cached fast path
    // GETs the container by id, then probes live bindings, then reconciles
    // drift via PATCH + rollout.
    cf.expectCallOrder(
      { method: 'GET', url: `/scripts/${HOST_SCRIPT_NAME}` },
      { method: 'PUT', url: `/scripts/${HOST_SCRIPT_NAME}` },
      { method: 'GET', url: `/containers/applications/app_${CONTAINER_APP_NAME}` },
      { method: 'GET', url: `/scripts/${HOST_SCRIPT_NAME}/bindings` },
      { method: 'PATCH', url: `/containers/applications/app_${CONTAINER_APP_NAME}` },
      { method: 'POST', url: `/containers/applications/app_${CONTAINER_APP_NAME}/rollouts` },
    );

    // No DELETE of the existing container — it belongs to a successful prior
    // deploy and must not be destroyed on a transient host-disappearance.
    expect(
      cf.state.recordedCalls.some(
        (c) => c.method === 'DELETE' && c.url.includes('/containers/applications/'),
      ),
    ).toBe(false);
    // No fresh container POST — the existing app was reused.
    expect(
      cf.state.recordedCalls.some(
        (c) => c.method === 'POST' && c.url.endsWith('/containers/applications'),
      ),
    ).toBe(false);

    // Host PUT carried initial migrations (no prior tag).
    expect(cf.state.hostScripts.get(HOST_SCRIPT_NAME)!.migration_tag).toBe(HOST_MIGRATION_TAG);

    // Container is still on the host's namespace; image was patched to desired.
    const appAfter = Array.from(cf.state.containerApps.values()).find(
      (a) => a.name === CONTAINER_APP_NAME,
    );
    expect(appAfter).toBeDefined();
    expect(appAfter!.durable_objects.namespace_id).toBe(HOST_NAMESPACE_ID);
    expect(appAfter!.configuration.image).toBe(DESIRED_IMAGE);

    // No UPSERT — cached fast path returned after reconciling drift; the row
    // already matches what would be written.
    expect(dbState.inserts).toHaveLength(0);
  });

  it('5. pre-PR-#0067 stuck-tenant fixture: throws with runbook hint and performs no compensating DELETE', async () => {
    // Stale container app on a different namespace + DB row keyed by binding_name
    // = 'void-sandbox' with empty metadata. This is the pre-PR-#0067 state:
    // the container app is bound to a per-deploy DO namespace from before the
    // cross-script host architecture. The DO namespace binding is immutable on
    // PATCH, so the platform cannot self-heal; the operator must manually
    // delete the stale container app before the tenant's next deploy.
    cf.seedContainerApp({
      name: CONTAINER_APP_NAME,
      namespaceId: 'ns_stale_per_deploy',
      image: 'registry.cloudflare.com/sandbox:0.5.0',
      instanceType: DESIRED_INSTANCE_TYPE,
      maxInstances: DESIRED_MAX_INSTANCES,
    });
    dbState.resourceRows = [
      {
        id: 'res_pre_fix',
        project_id: PROJECT_ID,
        type: 'container',
        cf_id: `app_${CONTAINER_APP_NAME}`,
        binding_name: CONTAINER_NAME,
        metadata: {}, // empty — pre-fix schema
        created_at: new Date().toISOString(),
      },
    ];

    await expect(
      provisionSandboxHost(
        ENV,
        stubDb,
        PROJECT_ID,
        SLUG,
        CONTAINER_NAME,
        DESIRED_IMAGE,
        DESIRED_INSTANCE_TYPE,
        DESIRED_MAX_INSTANCES,
      ),
    ).rejects.toThrow(/wrangler containers delete/);

    // No DELETE was issued against the stale container — operator runbook
    // owns the cutover, not the platform.
    const containerDeletes = cf.state.recordedCalls.filter(
      (c) => c.method === 'DELETE' && c.url.includes('/containers/applications/'),
    );
    expect(containerDeletes).toHaveLength(0);

    // Stale container app still present in CF state.
    const appAfter = Array.from(cf.state.containerApps.values()).find(
      (a) => a.name === CONTAINER_APP_NAME,
    );
    expect(appAfter).toBeDefined();
    expect(appAfter!.durable_objects.namespace_id).toBe('ns_stale_per_deploy');

    // No UPSERT — transaction rolled back on the throw.
    expect(dbState.inserts).toHaveLength(0);
  });

  it('6. partial-failure replay: host already PUT (tag set), no resource row → re-enter create-or-recover; PUT body OMITS migrations; namespace_id preserved; container POSTed; row written', async () => {
    cf.seedHostScript({
      scriptName: HOST_SCRIPT_NAME,
      migrationTag: HOST_MIGRATION_TAG,
      classes: { Sandbox: HOST_NAMESPACE_ID },
      bindings: [
        {
          type: 'durable_object_namespace',
          name: 'SANDBOX',
          class_name: 'Sandbox',
          namespace_id: HOST_NAMESPACE_ID,
        },
      ],
    });
    // No DB row (resource UPSERT never landed).
    dbState.resourceRows = [];

    // Capture the actual host PUT body so we can assert `migrations` field is
    // omitted entirely (the regression-test from design-doc 0067 §12 #6).
    const realFetch = global.fetch;
    let capturedHostPutMetadata: Record<string, unknown> | null = null;
    global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request | URL).toString();
      if (
        init?.method === 'PUT' &&
        url.includes(`/scripts/${HOST_SCRIPT_NAME}`) &&
        init.body instanceof FormData
      ) {
        const meta = init.body.get('metadata');
        if (meta instanceof Blob) {
          capturedHostPutMetadata = JSON.parse(await meta.text());
        }
      }
      return (realFetch as typeof fetch)(input as RequestInfo | URL, init);
    }) as typeof fetch;

    const info = await provisionSandboxHost(
      ENV,
      stubDb,
      PROJECT_ID,
      SLUG,
      CONTAINER_NAME,
      DESIRED_IMAGE,
      DESIRED_INSTANCE_TYPE,
      DESIRED_MAX_INSTANCES,
    );

    expect(info.namespaceId).toBe(HOST_NAMESPACE_ID); // not rotated

    // Host PUT body must omit `migrations`.
    expect(capturedHostPutMetadata).not.toBeNull();
    expect(capturedHostPutMetadata).not.toHaveProperty('migrations');
    // But other host metadata is still present.
    expect(capturedHostPutMetadata!.main_module).toBe('index.js');

    // Migration tag is preserved.
    expect(cf.state.hostScripts.get(HOST_SCRIPT_NAME)!.migration_tag).toBe(HOST_MIGRATION_TAG);
    // Sandbox class still maps to the original namespace.
    expect(cf.state.hostScripts.get(HOST_SCRIPT_NAME)!.classes.get('Sandbox')).toBe(
      HOST_NAMESPACE_ID,
    );

    // Container app POSTed fresh.
    const app = cf.state.containerApps.get(`app_${CONTAINER_APP_NAME}`);
    expect(app).toBeDefined();
    expect(app!.durable_objects.namespace_id).toBe(HOST_NAMESPACE_ID);

    // Row written.
    expect(dbState.inserts).toHaveLength(1);
    expect(dbState.inserts[0]!.values).toMatchObject({
      cf_id: `app_${CONTAINER_APP_NAME}`,
      binding_name: CONTAINER_NAME,
      metadata: { namespaceId: HOST_NAMESPACE_ID, hostScriptName: HOST_SCRIPT_NAME },
    });
  });

  it('7. POST returns 409 with the lock held → re-find with namespace match → returns it; logs WARN', async () => {
    // Reproduce the race: findContainerApplication initially returns nothing
    // (no pre-existing app), so we go straight to POST. The mock's POST
    // handler is overridden to return 409 the first time. The re-find then
    // returns an out-of-band created app on the host's namespace.
    //
    // The host doesn't exist yet, so the namespace_id minted on host PUT is
    // deterministic (`ns_do-host-${slug}_Sandbox`).
    let postCount = 0;
    let appearAfterConflict = false;
    cf = mockCfApi({
      createContainerApp: async (_url, init) => {
        postCount += 1;
        if (postCount === 1) {
          // Simulate out-of-band creation right before our POST hits CF.
          appearAfterConflict = true;
          return Response.json(
            { success: false, errors: [{ code: 1000, message: 'already exists' }] },
            { status: 409 },
          );
        }
        // Fallback to real default behavior for any later POSTs.
        let body: Record<string, unknown> = {};
        if (typeof init?.body === 'string') {
          try {
            body = JSON.parse(init.body) as Record<string, unknown>;
          } catch {
            // ignore
          }
        }
        const name = typeof body.name === 'string' ? body.name : '';
        const durableObjects = (body.durable_objects as { namespace_id?: string } | undefined) ?? {
          namespace_id: '',
        };
        const configuration =
          (body.configuration as { image?: string; instance_type?: string } | undefined) ?? {};
        const created = {
          id: `app_${name}`,
          name,
          scheduling_policy: 'default',
          configuration: {
            image: configuration.image,
            instance_type: configuration.instance_type ?? 'lite',
          },
          max_instances: typeof body.max_instances === 'number' ? body.max_instances : 20,
          durable_objects: { namespace_id: durableObjects.namespace_id ?? '' },
        };
        cf.state.containerApps.set(created.id, created);
        return Response.json({ success: true, errors: [], result: created });
      },
      listContainerApps: (url) => {
        const u = new URL(url);
        const name = u.searchParams.get('name');
        if (name && appearAfterConflict) {
          const found = cf.state.containerApps.get(`app_${name}`);
          if (found) {
            return Response.json({ success: true, errors: [], result: [found] });
          }
          // Synthesize the post-conflict app on the host namespace.
          const synth = {
            id: `app_${name}`,
            name,
            scheduling_policy: 'default',
            configuration: { image: DESIRED_IMAGE, instance_type: DESIRED_INSTANCE_TYPE },
            max_instances: DESIRED_MAX_INSTANCES,
            durable_objects: { namespace_id: HOST_NAMESPACE_ID },
          };
          cf.state.containerApps.set(synth.id, synth);
          return Response.json({ success: true, errors: [], result: [synth] });
        }
        return Response.json({
          success: true,
          errors: [],
          result: Array.from(cf.state.containerApps.values()).filter(
            (a) => !name || a.name === name,
          ),
        });
      },
    });

    dbState.resourceRows = []; // no DB row → create-or-recover

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const info = await provisionSandboxHost(
      ENV,
      stubDb,
      PROJECT_ID,
      SLUG,
      CONTAINER_NAME,
      DESIRED_IMAGE,
      DESIRED_INSTANCE_TYPE,
      DESIRED_MAX_INSTANCES,
    );

    expect(info.containerApplicationId).toBe(`app_${CONTAINER_APP_NAME}`);
    expect(info.namespaceId).toBe(HOST_NAMESPACE_ID);

    // POST was attempted exactly once (returned 409).
    expect(postCount).toBe(1);

    // WARN logged about the unexpected race.
    const warnedAboutRace = warnSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === 'string' && a.includes('unexpected 409')),
    );
    expect(warnedAboutRace).toBe(true);

    // Row UPSERTed.
    expect(dbState.inserts).toHaveLength(1);
    expect(dbState.inserts[0]!.values).toMatchObject({
      cf_id: `app_${CONTAINER_APP_NAME}`,
      metadata: { namespaceId: HOST_NAMESPACE_ID, hostScriptName: HOST_SCRIPT_NAME },
    });

    warnSpy.mockRestore();
  });

  it('8. project status === "deleting" → throws ProjectDeletingError BEFORE any CF mutation', async () => {
    dbState.project = { ...dbState.project!, status: 'deleting' };

    await expect(
      provisionSandboxHost(
        ENV,
        stubDb,
        PROJECT_ID,
        SLUG,
        CONTAINER_NAME,
        DESIRED_IMAGE,
        DESIRED_INSTANCE_TYPE,
        DESIRED_MAX_INSTANCES,
      ),
    ).rejects.toBeInstanceOf(ProjectDeletingError);

    // No CF mutation: no PUTs, no POSTs, no DELETEs.
    expect(
      cf.state.recordedCalls.some((c) => ['PUT', 'POST', 'DELETE', 'PATCH'].includes(c.method)),
    ).toBe(false);
    // No DB writes.
    expect(dbState.inserts).toHaveLength(0);
  });

  it('15. external-delete recovery: cache present + host HEAD 404 + container on cached namespace → DELETE+POST against the new host namespace; row updated', async () => {
    // Scenario: a previously-healthy sandbox project's host script was
    // deleted externally (e.g. operator ran `wrangler delete`). The cached
    // resources row still has `metadata.namespaceId = OLD_NS`, and the
    // container application exists on `OLD_NS`. On the next deploy:
    //   - cached fast path: HEAD on the host script 404s → fall through.
    //   - putSandboxHostScript mints a fresh host namespace (HOST_NAMESPACE_ID).
    //   - findContainerApplication returns the container bound to OLD_NS.
    //   - cachedNamespaceId === OLD_NS, so this is the safe external-delete
    //     recovery branch: DELETE the stale container + POST a fresh one.
    const OLD_NS = 'ns_externally_rotated';
    cf.seedContainerApp({
      name: CONTAINER_APP_NAME,
      namespaceId: OLD_NS,
      image: DESIRED_IMAGE,
      instanceType: DESIRED_INSTANCE_TYPE,
      maxInstances: DESIRED_MAX_INSTANCES,
    });
    dbState.resourceRows = [
      {
        id: 'res_existing',
        project_id: PROJECT_ID,
        type: 'container',
        cf_id: `app_${CONTAINER_APP_NAME}`,
        binding_name: CONTAINER_NAME,
        // Cache is present and points at the old namespace + host script.
        metadata: { namespaceId: OLD_NS, hostScriptName: HOST_SCRIPT_NAME },
        created_at: new Date().toISOString(),
      },
    ];

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const info = await provisionSandboxHost(
      ENV,
      stubDb,
      PROJECT_ID,
      SLUG,
      CONTAINER_NAME,
      DESIRED_IMAGE,
      DESIRED_INSTANCE_TYPE,
      DESIRED_MAX_INSTANCES,
    );

    // Recovered to the freshly-minted host namespace, NOT the cached old one.
    expect(info.namespaceId).toBe(HOST_NAMESPACE_ID);
    expect(info.scriptName).toBe(HOST_SCRIPT_NAME);
    expect(info.containerApplicationId).toBe(`app_${CONTAINER_APP_NAME}`);

    // Order: HEAD host (cached fast path) → 404 → PUT host → GET bindings →
    // GET container by name → DELETE stale container → POST fresh container.
    cf.expectCallOrder(
      { method: 'GET', url: `/scripts/${HOST_SCRIPT_NAME}` },
      { method: 'PUT', url: `/scripts/${HOST_SCRIPT_NAME}` },
      { method: 'GET', url: `/scripts/${HOST_SCRIPT_NAME}/bindings` },
      { method: 'DELETE', url: `/containers/applications/app_${CONTAINER_APP_NAME}` },
      { method: 'POST', url: '/containers/applications' },
    );

    // WARN logged about the external-delete recovery.
    const warnedAboutRecovery = warnSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === 'string' && a.includes('external-delete recovery')),
    );
    expect(warnedAboutRecovery).toBe(true);

    // Container is now bound to the new host namespace.
    const appAfter = Array.from(cf.state.containerApps.values()).find(
      (a) => a.name === CONTAINER_APP_NAME,
    );
    expect(appAfter).toBeDefined();
    expect(appAfter!.durable_objects.namespace_id).toBe(HOST_NAMESPACE_ID);

    // Resource row UPSERTed with the new namespaceId.
    expect(dbState.inserts).toHaveLength(1);
    expect(dbState.inserts[0]!.values).toMatchObject({
      cf_id: `app_${CONTAINER_APP_NAME}`,
      binding_name: CONTAINER_NAME,
      metadata: { namespaceId: HOST_NAMESPACE_ID, hostScriptName: HOST_SCRIPT_NAME },
    });
    expect(dbState.inserts[0]!.conflict?.set).toMatchObject({
      cf_id: `app_${CONTAINER_APP_NAME}`,
      metadata: { namespaceId: HOST_NAMESPACE_ID, hostScriptName: HOST_SCRIPT_NAME },
    });

    warnSpy.mockRestore();
  });

  it('16. stuck-tenant throw without cache: NO resource row + container on unknown namespace → throws with runbook hint, no DELETE issued', async () => {
    // Pre-PR-#0067 stuck-tenant on a fresh provisioning attempt: there is
    // NO resources row at all (operator never ran a successful deploy under
    // the new code path), so cachedNamespaceId is undefined. A container
    // app exists on some unknown per-deploy namespace. We cannot safely
    // auto-DELETE because we have no verified record that the platform
    // owns this container.
    cf.seedContainerApp({
      name: CONTAINER_APP_NAME,
      namespaceId: 'ns_unknown_per_deploy',
      image: 'registry.cloudflare.com/sandbox:0.5.0',
      instanceType: DESIRED_INSTANCE_TYPE,
      maxInstances: DESIRED_MAX_INSTANCES,
    });
    dbState.resourceRows = []; // no cache at all

    await expect(
      provisionSandboxHost(
        ENV,
        stubDb,
        PROJECT_ID,
        SLUG,
        CONTAINER_NAME,
        DESIRED_IMAGE,
        DESIRED_INSTANCE_TYPE,
        DESIRED_MAX_INSTANCES,
      ),
    ).rejects.toThrow(/wrangler containers delete/);

    // No DELETE issued — operator-only cutover.
    const containerDeletes = cf.state.recordedCalls.filter(
      (c) => c.method === 'DELETE' && c.url.includes('/containers/applications/'),
    );
    expect(containerDeletes).toHaveLength(0);

    // No fresh container POST.
    expect(
      cf.state.recordedCalls.some(
        (c) => c.method === 'POST' && c.url.endsWith('/containers/applications'),
      ),
    ).toBe(false);

    // Stale container untouched.
    const appAfter = Array.from(cf.state.containerApps.values()).find(
      (a) => a.name === CONTAINER_APP_NAME,
    );
    expect(appAfter).toBeDefined();
    expect(appAfter!.durable_objects.namespace_id).toBe('ns_unknown_per_deploy');

    // No DB write — transaction rolled back on the throw.
    expect(dbState.inserts).toHaveLength(0);
  });

  it('17. namespace lookup retry: 2 transient binding-absent responses, then success → deploy succeeds; WARN logged on each miss', async () => {
    // Simulate CF's per-script bindings endpoint propagation lag: after a
    // successful host PUT, the first two GET /bindings calls return a
    // payload that does NOT include the SANDBOX entry (so
    // findDurableObjectNamespaceId throws "binding not found"); the third
    // call returns the fully-resolved bindings. The retry/backoff in
    // provisionSandboxHost must absorb these so the deploy succeeds.
    let bindingsCallCount = 0;
    cf = mockCfApi({
      listWorkerBindings: (url) => {
        const m = /\/scripts\/([^/]+)\/bindings/.exec(url);
        const scriptName = m ? decodeURIComponent(m[1]!) : null;
        if (scriptName === HOST_SCRIPT_NAME) {
          bindingsCallCount += 1;
          if (bindingsCallCount <= 2) {
            // Empty bindings list — findDurableObjectNamespaceId will throw.
            return Response.json({ success: true, errors: [], result: [] });
          }
          // Third+ call: return the real bindings from state.
          const script = cf.state.hostScripts.get(scriptName);
          if (script) {
            return Response.json({ success: true, errors: [], result: script.bindings });
          }
        }
        return Response.json({
          success: true,
          errors: [],
          result: [{ type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: 'mock-proxy-token' }],
        });
      },
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const info = await provisionSandboxHost(
      ENV,
      stubDb,
      PROJECT_ID,
      SLUG,
      CONTAINER_NAME,
      DESIRED_IMAGE,
      DESIRED_INSTANCE_TYPE,
      DESIRED_MAX_INSTANCES,
    );

    // Eventually succeeded with the live namespace_id.
    expect(info.namespaceId).toBe(HOST_NAMESPACE_ID);
    expect(info.containerApplicationId).toBe(`app_${CONTAINER_APP_NAME}`);

    // Bindings endpoint was hit at least 3 times.
    expect(bindingsCallCount).toBeGreaterThanOrEqual(3);

    // WARN logged on each transient miss.
    const probeMissWarns = warnSpy.mock.calls.filter((args) =>
      args.some((a) => typeof a === 'string' && a.includes('namespace probe miss')),
    );
    expect(probeMissWarns.length).toBeGreaterThanOrEqual(2);

    // Container was POSTed and resource row written.
    expect(dbState.inserts).toHaveLength(1);
    expect(dbState.inserts[0]!.values).toMatchObject({
      cf_id: `app_${CONTAINER_APP_NAME}`,
      metadata: { namespaceId: HOST_NAMESPACE_ID, hostScriptName: HOST_SCRIPT_NAME },
    });

    warnSpy.mockRestore();
  });
});

describe('putSandboxHostScript', () => {
  let cf: MockCfApiHandle;

  beforeEach(() => {
    cf = mockCfApi();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('9. tag === null → PUT body INCLUDES migrations { new_tag, steps: [{ new_sqlite_classes: ["Sandbox"] }] } AND containers: [{ class_name: "Sandbox" }] (CF Workers Upload API shape)', async () => {
    // No host script seeded → fetchScriptMigrationTag returns null (404 path).
    let captured: Record<string, unknown> | null = null;
    const realFetch = global.fetch;
    global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request | URL).toString();
      if (
        init?.method === 'PUT' &&
        url.includes(`/scripts/${HOST_SCRIPT_NAME}`) &&
        init.body instanceof FormData
      ) {
        const meta = init.body.get('metadata');
        if (meta instanceof Blob) {
          captured = JSON.parse(await meta.text());
        }
      }
      return (realFetch as typeof fetch)(input as RequestInfo | URL, init);
    }) as typeof fetch;

    await putSandboxHostScript('acct-test', 'token-test', 'void-users', SLUG);

    expect(captured).not.toBeNull();
    expect(captured!.migrations).toEqual({
      new_tag: HOST_MIGRATION_TAG,
      steps: [{ new_sqlite_classes: ['Sandbox'] }],
    });
    // Self-binding required.
    expect(captured!.bindings).toEqual([
      { type: 'durable_object_namespace', name: 'SANDBOX', class_name: 'Sandbox' },
    ]);
    // Containers capability marker required — without it, cross-script DO
    // bindings on user workers fail with DURABLE_OBJECT_NOT_CONTAINER_ENABLED.
    expect(captured!.containers).toEqual([{ class_name: 'Sandbox' }]);
    expect(captured!.main_module).toBe('index.js');
  });

  it('10. tag === "void-sandbox-host-v1" → PUT body OMITS migrations entirely BUT still includes containers: [{ class_name: "Sandbox" }]', async () => {
    cf.seedHostScript({
      scriptName: HOST_SCRIPT_NAME,
      migrationTag: HOST_MIGRATION_TAG,
      classes: { Sandbox: HOST_NAMESPACE_ID },
      bindings: [
        {
          type: 'durable_object_namespace',
          name: 'SANDBOX',
          class_name: 'Sandbox',
          namespace_id: HOST_NAMESPACE_ID,
        },
      ],
    });

    let captured: Record<string, unknown> | null = null;
    const realFetch = global.fetch;
    global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request | URL).toString();
      if (
        init?.method === 'PUT' &&
        url.includes(`/scripts/${HOST_SCRIPT_NAME}`) &&
        init.body instanceof FormData
      ) {
        const meta = init.body.get('metadata');
        if (meta instanceof Blob) {
          captured = JSON.parse(await meta.text());
        }
      }
      return (realFetch as typeof fetch)(input as RequestInfo | URL, init);
    }) as typeof fetch;

    await putSandboxHostScript('acct-test', 'token-test', 'void-users', SLUG);

    expect(captured).not.toBeNull();
    expect(captured).not.toHaveProperty('migrations');
    expect(captured!.bindings).toEqual([
      { type: 'durable_object_namespace', name: 'SANDBOX', class_name: 'Sandbox' },
    ]);
    // Containers capability marker MUST also be present in the re-PUT branch
    // (it's a class-capability declaration, independent of migrations). This
    // is the regression test for the production failure where existing
    // tenants' hosts were missing this field after PR #131.
    expect(captured!.containers).toEqual([{ class_name: 'Sandbox' }]);
  });

  it('10b. containers: [{ class_name: "Sandbox" }] is ALWAYS present in the PUT body, regardless of migration_tag branch (regression test for DURABLE_OBJECT_NOT_CONTAINER_ENABLED)', async () => {
    // Capture the host PUT body across two scenarios: tag=null (first create)
    // and tag=HOST_MIGRATION_TAG (re-PUT on existing host). Both bodies MUST
    // declare the container capability so cross-script DO bindings work.
    const realFetch = global.fetch;
    let captureSlot: Record<string, unknown> | null = null;
    global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request | URL).toString();
      if (
        init?.method === 'PUT' &&
        url.includes(`/scripts/${HOST_SCRIPT_NAME}`) &&
        init.body instanceof FormData
      ) {
        const meta = init.body.get('metadata');
        if (meta instanceof Blob) {
          captureSlot = JSON.parse(await meta.text());
        }
      }
      return (realFetch as typeof fetch)(input as RequestInfo | URL, init);
    }) as typeof fetch;

    // Branch 1: tag === null (no host script seeded).
    captureSlot = null;
    await putSandboxHostScript('acct-test', 'token-test', 'void-users', SLUG);
    expect(captureSlot).not.toBeNull();
    expect(captureSlot!.containers).toEqual([{ class_name: 'Sandbox' }]);
    // And migrations are present in this branch — sanity check.
    expect(captureSlot).toHaveProperty('migrations');

    // Branch 2: tag === HOST_MIGRATION_TAG (re-PUT). Seed an already-migrated
    // host so fetchScriptMigrationTag returns the live tag.
    cf.seedHostScript({
      scriptName: HOST_SCRIPT_NAME,
      migrationTag: HOST_MIGRATION_TAG,
      classes: { Sandbox: HOST_NAMESPACE_ID },
    });
    captureSlot = null;
    await putSandboxHostScript('acct-test', 'token-test', 'void-users', SLUG);
    expect(captureSlot).not.toBeNull();
    expect(captureSlot!.containers).toEqual([{ class_name: 'Sandbox' }]);
    // Migrations OMITTED in this branch — sanity check.
    expect(captureSlot).not.toHaveProperty('migrations');
  });

  // Sanity check on `fetchScriptMigrationTag` so test #6's regression assertion
  // is robust: the helper actually returns the live tag for an existing script.
  it('fetchScriptMigrationTag returns the live tag for an existing script and null on 404', async () => {
    cf.seedHostScript({
      scriptName: HOST_SCRIPT_NAME,
      migrationTag: HOST_MIGRATION_TAG,
      classes: { Sandbox: HOST_NAMESPACE_ID },
    });
    await expect(
      fetchScriptMigrationTag('acct-test', 'token-test', 'void-users', HOST_SCRIPT_NAME),
    ).resolves.toBe(HOST_MIGRATION_TAG);
    await expect(
      fetchScriptMigrationTag('acct-test', 'token-test', 'void-users', 'do-host-nonexistent'),
    ).resolves.toBeNull();
  });
});

describe('deleteContainerApplicationIdempotent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('11a. swallows 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { success: false, errors: [{ code: 1000, message: 'not found' }] },
          { status: 404 },
        ),
      ),
    );

    await expect(
      deleteContainerApplicationIdempotent('acct-test', 'token-test', 'app_missing'),
    ).resolves.toBeUndefined();
  });

  it('11b. propagates non-404 errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { success: false, errors: [{ code: 1000, message: 'internal error' }] },
          { status: 500 },
        ),
      ),
    );

    await expect(
      deleteContainerApplicationIdempotent('acct-test', 'token-test', 'app_x'),
    ).rejects.toBeInstanceOf(CloudflareApiError);
  });
});

// Tests #12 and #13 (per design-doc 0067 §12) cover the metadata-rewrite logic
// in deploy.ts (NOT sandbox-host.ts). The "rewriteSandboxMetadataForCrossScriptHost"
// name in the design doc is a placeholder — the actual exported helpers are
// `buildSandboxUploadBindings`, `buildSandboxUploadContainers`, and
// `buildDurableObjectUploadMigrations`, each accepting a
// `crossScriptHost: { scriptName: string } | null` argument.

describe('cross-script host metadata rewrite (deploy.ts helpers)', () => {
  const sandboxManifest = {
    bindingName: 'SANDBOX',
    className: 'Sandbox',
    containerName: CONTAINER_NAME,
    image: DESIRED_IMAGE,
    migrations: [{ tag: 'sandbox-v1', newSqliteClasses: ['Sandbox'] }],
  };

  it('12. with crossScriptHost: bindings rewritten to script_name; Sandbox stripped from new_sqlite_classes; containers block removed', async () => {
    const host = { scriptName: HOST_SCRIPT_NAME };

    // Bindings: script_name added.
    const bindings = buildSandboxUploadBindings(sandboxManifest, host);
    expect(bindings).toEqual([
      {
        type: 'durable_object_namespace',
        name: 'SANDBOX',
        class_name: 'Sandbox',
        script_name: HOST_SCRIPT_NAME,
      },
    ]);

    // Migrations: sandbox migrations dropped entirely (no Sandbox class on user worker).
    const migrations = buildDurableObjectUploadMigrations(
      undefined,
      sandboxManifest.migrations,
      host,
    );
    expect(migrations).toBeUndefined();

    // Containers: removed.
    const containers = buildSandboxUploadContainers(sandboxManifest, host);
    expect(containers).toBeUndefined();
  });

  it('13. without crossScriptHost (or non-sandbox manifest): pass-through unchanged', async () => {
    // Same-script form (no crossScriptHost) — bindings have no script_name.
    const bindingsSame = buildSandboxUploadBindings(sandboxManifest, null);
    expect(bindingsSame).toEqual([
      { type: 'durable_object_namespace', name: 'SANDBOX', class_name: 'Sandbox' },
    ]);

    // Migrations include the sandbox class (preserved when host is null).
    const migrationsSame = buildDurableObjectUploadMigrations(
      undefined,
      sandboxManifest.migrations,
      null,
    );
    expect(migrationsSame).toEqual({
      new_tag: 'sandbox-v1',
      steps: [{ new_sqlite_classes: ['Sandbox'] }],
    });

    // Containers preserved.
    const containersSame = buildSandboxUploadContainers(sandboxManifest, null);
    expect(containersSame).toEqual([{ class_name: 'Sandbox' }]);

    // Non-sandbox manifest with crossScriptHost: still pass-through (no sandbox to rewrite).
    expect(buildSandboxUploadBindings(undefined, { scriptName: HOST_SCRIPT_NAME })).toEqual([]);
    expect(
      buildSandboxUploadContainers(undefined, { scriptName: HOST_SCRIPT_NAME }),
    ).toBeUndefined();
    // Pure websocket migrations are preserved when sandbox is absent and host is null.
    const wsOnly = buildDurableObjectUploadMigrations(
      [{ tag: 'ws-v1', newClasses: ['Chat'] }],
      undefined,
      null,
    );
    expect(wsOnly).toEqual({ new_tag: 'ws-v1', steps: [{ new_classes: ['Chat'] }] });
  });

  it('14. with crossScriptHost and a custom className: forces class_name to "Sandbox" while preserving the user-facing bindingName', () => {
    // The host script declares ONLY `new_sqlite_classes: ['Sandbox']`. A user
    // manifest with `className: 'CustomSandbox'` MUST be rewritten so the
    // cross-script binding points at a class the host actually exports.
    // The bindingName (alias in `env`) is the user's reference and stays.
    const customSandboxManifest = {
      bindingName: 'MY_SANDBOX',
      className: 'CustomSandbox',
      containerName: CONTAINER_NAME,
      image: DESIRED_IMAGE,
      migrations: [{ tag: 'sandbox-v1', newSqliteClasses: ['CustomSandbox'] }],
    };
    const host = { scriptName: HOST_SCRIPT_NAME };

    const crossScriptBindings = buildSandboxUploadBindings(customSandboxManifest, host);
    expect(crossScriptBindings).toEqual([
      {
        type: 'durable_object_namespace',
        name: 'MY_SANDBOX',
        class_name: 'Sandbox',
        script_name: HOST_SCRIPT_NAME,
      },
    ]);

    // Same manifest WITHOUT crossScriptHost (e.g. local `wrangler dev`):
    // user's `className` is preserved verbatim — same-script form references
    // the user worker's own class.
    const sameScriptBindings = buildSandboxUploadBindings(customSandboxManifest, null);
    expect(sameScriptBindings).toEqual([
      {
        type: 'durable_object_namespace',
        name: 'MY_SANDBOX',
        class_name: 'CustomSandbox',
      },
    ]);
  });
});
