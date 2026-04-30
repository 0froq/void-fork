import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  upsertSandboxContainerApplication,
  type ContainerApplicationInfo,
  type SandboxContainerConfig,
} from '../../src/provisioning/containers.ts';

const ACCOUNT = 'acc_test';
const TOKEN = 'token_test';
const APP_NAME = 'proj-r82rzcbk6z7v-void-sandbox';
const APP_ID = 'app-uuid-1';
const NAMESPACE_ID = 'ns-uuid-1';
const IMAGE = 'registry.cloudflare.com/void-sandbox:latest';

const BASE_CONFIG: SandboxContainerConfig = {
  name: APP_NAME,
  image: IMAGE,
  namespaceId: NAMESPACE_ID,
};

function cfSuccess(result: unknown): Response {
  return Response.json({ success: true, errors: [], result });
}

function cfError(message: string, status = 400): Response {
  return Response.json({ success: false, errors: [{ code: 100, message }] }, { status });
}

function makeApp(overrides: Partial<ContainerApplicationInfo> = {}): ContainerApplicationInfo {
  return {
    id: APP_ID,
    name: APP_NAME,
    scheduling_policy: 'default',
    configuration: { image: IMAGE, instance_type: 'lite' },
    durable_objects: { namespace_id: NAMESPACE_ID },
    max_instances: 20,
    ...overrides,
  };
}

describe('upsertSandboxContainerApplication', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('not-found: POSTs CreateApplicationRequest body and skips rollout', async () => {
    // 1. find -> empty list
    fetchMock.mockResolvedValueOnce(cfSuccess([]));
    // 2. POST -> created
    fetchMock.mockResolvedValueOnce(cfSuccess(makeApp()));

    const result = await upsertSandboxContainerApplication(ACCOUNT, TOKEN, BASE_CONFIG);

    expect(result).toEqual(makeApp());
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Find call: GET /applications?name=...
    const [findUrl, findInit] = fetchMock.mock.calls[0];
    expect(String(findUrl)).toMatch(
      /\/accounts\/acc_test\/containers\/applications\?name=proj-r82rzcbk6z7v-void-sandbox$/,
    );
    expect((findInit as RequestInit | undefined)?.method ?? 'GET').toBe('GET');

    // POST call: POST /applications with full CreateApplicationRequest body
    const [postUrl, postInit] = fetchMock.mock.calls[1];
    expect(String(postUrl)).toMatch(/\/accounts\/acc_test\/containers\/applications$/);
    expect((postInit as RequestInit).method).toBe('POST');
    const body = JSON.parse((postInit as RequestInit).body as string);
    expect(body).toEqual({
      name: APP_NAME,
      scheduling_policy: 'default',
      configuration: { image: IMAGE, instance_type: 'lite' },
      instances: 0,
      max_instances: 20,
      durable_objects: { namespace_id: NAMESPACE_ID },
      rollout_active_grace_period: 0,
    });
  });

  it('not-found with custom instanceType / maxInstances: forwards them to POST body', async () => {
    fetchMock.mockResolvedValueOnce(cfSuccess([]));
    fetchMock.mockResolvedValueOnce(
      cfSuccess(
        makeApp({
          configuration: { image: IMAGE, instance_type: 'standard' },
          max_instances: 5,
        }),
      ),
    );

    await upsertSandboxContainerApplication(ACCOUNT, TOKEN, {
      ...BASE_CONFIG,
      instanceType: 'standard',
      maxInstances: 5,
    });

    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body.configuration.instance_type).toBe('standard');
    expect(body.max_instances).toBe(5);
  });

  it('409 / "already exists" on POST: re-finds and falls through to PATCH + rollout', async () => {
    const stale = makeApp({
      configuration: { image: 'old-image:1', instance_type: 'lite' },
      max_instances: 20,
    });

    // 1. find -> empty
    fetchMock.mockResolvedValueOnce(cfSuccess([]));
    // 2. POST -> already exists
    fetchMock.mockResolvedValueOnce(cfError('application with this name already exists', 409));
    // 3. re-find -> stale app
    fetchMock.mockResolvedValueOnce(cfSuccess([stale]));
    // 4. PATCH -> updated
    fetchMock.mockResolvedValueOnce(
      cfSuccess(
        makeApp({
          configuration: { image: IMAGE, instance_type: 'lite' },
          max_instances: 20,
        }),
      ),
    );
    // 5. rollout -> ok
    fetchMock.mockResolvedValueOnce(cfSuccess({ id: 'rollout-1' }));

    const result = await upsertSandboxContainerApplication(ACCOUNT, TOKEN, BASE_CONFIG);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(result.id).toBe(APP_ID);

    // PATCH body shape — must NOT include durable_objects or name
    const [patchUrl, patchInit] = fetchMock.mock.calls[3];
    expect(String(patchUrl)).toMatch(
      new RegExp(`/accounts/acc_test/containers/applications/${APP_ID}$`),
    );
    expect((patchInit as RequestInit).method).toBe('PATCH');
    const patchBody = JSON.parse((patchInit as RequestInit).body as string);
    expect(patchBody).toEqual({
      configuration: { image: IMAGE, instance_type: 'lite' },
      max_instances: 20,
      scheduling_policy: 'default',
      rollout_active_grace_period: 0,
    });
    expect(patchBody).not.toHaveProperty('durable_objects');
    expect(patchBody).not.toHaveProperty('name');

    // Rollout body shape
    const [rolloutUrl, rolloutInit] = fetchMock.mock.calls[4];
    expect(String(rolloutUrl)).toMatch(
      new RegExp(`/accounts/acc_test/containers/applications/${APP_ID}/rollouts$`),
    );
    expect((rolloutInit as RequestInit).method).toBe('POST');
    const rolloutBody = JSON.parse((rolloutInit as RequestInit).body as string);
    expect(rolloutBody).toEqual({
      description: 'void platform sandbox config update',
      strategy: 'rolling',
      target_configuration: { image: IMAGE, instance_type: 'lite' },
      step_percentage: 100,
      kind: 'full_auto',
    });
  });

  it('found and unchanged: returns existing without PATCH or rollout', async () => {
    const matching = makeApp(); // image+instance_type+max_instances all match BASE_CONFIG defaults

    fetchMock.mockResolvedValueOnce(cfSuccess([matching]));

    const result = await upsertSandboxContainerApplication(ACCOUNT, TOKEN, BASE_CONFIG);

    expect(result).toEqual(matching);
    // Only the find call; no PATCH, no rollout.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('found and changed: PATCHes (no durable_objects, no name) and POSTs rollout', async () => {
    const stale = makeApp({
      configuration: { image: 'stale:0', instance_type: 'dev' },
      max_instances: 1,
    });

    fetchMock.mockResolvedValueOnce(cfSuccess([stale]));
    fetchMock.mockResolvedValueOnce(
      cfSuccess(
        makeApp({
          configuration: { image: IMAGE, instance_type: 'lite' },
          max_instances: 20,
        }),
      ),
    );
    fetchMock.mockResolvedValueOnce(cfSuccess({ id: 'rollout-2' }));

    await upsertSandboxContainerApplication(ACCOUNT, TOKEN, BASE_CONFIG);

    expect(fetchMock).toHaveBeenCalledTimes(3);

    const patchBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(patchBody.configuration).toEqual({ image: IMAGE, instance_type: 'lite' });
    expect(patchBody.max_instances).toBe(20);
    expect(patchBody.scheduling_policy).toBe('default');
    expect(patchBody.rollout_active_grace_period).toBe(0);
    expect(patchBody).not.toHaveProperty('durable_objects');
    expect(patchBody).not.toHaveProperty('name');
    expect(patchBody).not.toHaveProperty('instances');

    const rolloutBody = JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string);
    expect(rolloutBody).toEqual({
      description: 'void platform sandbox config update',
      strategy: 'rolling',
      target_configuration: { image: IMAGE, instance_type: 'lite' },
      step_percentage: 100,
      kind: 'full_auto',
    });
  });

  it('found with mismatched durable_objects.namespace_id: throws and does not PATCH or rollout', async () => {
    const mismatched = makeApp({
      durable_objects: { namespace_id: 'different-ns-id' },
    });
    fetchMock.mockResolvedValueOnce(cfSuccess([mismatched]));

    await expect(upsertSandboxContainerApplication(ACCOUNT, TOKEN, BASE_CONFIG)).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(
          new RegExp(`${APP_NAME}.*${NAMESPACE_ID}.*different-ns-id.*delete`, 'is'),
        ),
      }),
    );

    // Only the find call fired — no PATCH, no rollout.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('found with missing durable_objects: throws with "none" placeholder and does not PATCH or rollout', async () => {
    const noNamespace = makeApp({ durable_objects: undefined });
    fetchMock.mockResolvedValueOnce(cfSuccess([noNamespace]));

    await expect(upsertSandboxContainerApplication(ACCOUNT, TOKEN, BASE_CONFIG)).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(
          new RegExp(`${APP_NAME}.*${NAMESPACE_ID}.*none.*delete`, 'is'),
        ),
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('post-409 re-find returns mismatched namespace: throws instead of silently PATCHing', async () => {
    const mismatched = makeApp({
      durable_objects: { namespace_id: 'different-ns-id' },
    });

    // 1. find -> empty
    fetchMock.mockResolvedValueOnce(cfSuccess([]));
    // 2. POST -> 409 race
    fetchMock.mockResolvedValueOnce(cfError('application with this name already exists', 409));
    // 3. re-find -> app with WRONG namespace_id
    fetchMock.mockResolvedValueOnce(cfSuccess([mismatched]));

    await expect(upsertSandboxContainerApplication(ACCOUNT, TOKEN, BASE_CONFIG)).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(
          new RegExp(`${APP_NAME}.*${NAMESPACE_ID}.*different-ns-id.*delete`, 'is'),
        ),
      }),
    );

    // find + POST + re-find — no PATCH, no rollout.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(init?.method ?? 'GET').not.toBe('PATCH');
      const url = String(call[0]);
      expect(url).not.toMatch(/\/rollouts$/);
    }
  });

  it('non-conflict POST error propagates without falling back to PATCH', async () => {
    fetchMock.mockResolvedValueOnce(cfSuccess([]));
    fetchMock.mockResolvedValueOnce(cfError('insufficient permissions', 403));

    await expect(upsertSandboxContainerApplication(ACCOUNT, TOKEN, BASE_CONFIG)).rejects.toThrow(
      /insufficient permissions/i,
    );

    // find + POST only — no re-find, no PATCH, no rollout.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('status 409 with non-matching error message: status alone triggers PATCH fallback', async () => {
    // Authoritative-status case: CF returns 409 but the body message does NOT
    // contain "already exists" / "duplicate" / "conflict". The race-fallback
    // must still fire because status 409 is the spec'd race signal.
    const stale = makeApp({
      configuration: { image: 'old-image:1', instance_type: 'lite' },
      max_instances: 20,
    });

    // 1. find -> empty
    fetchMock.mockResolvedValueOnce(cfSuccess([]));
    // 2. POST -> 409 with an unrelated message
    fetchMock.mockResolvedValueOnce(cfError('some unrelated cf error', 409));
    // 3. re-find -> stale app
    fetchMock.mockResolvedValueOnce(cfSuccess([stale]));
    // 4. PATCH -> updated
    fetchMock.mockResolvedValueOnce(
      cfSuccess(
        makeApp({
          configuration: { image: IMAGE, instance_type: 'lite' },
          max_instances: 20,
        }),
      ),
    );
    // 5. rollout -> ok
    fetchMock.mockResolvedValueOnce(cfSuccess({ id: 'rollout-3' }));

    const result = await upsertSandboxContainerApplication(ACCOUNT, TOKEN, BASE_CONFIG);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(result.id).toBe(APP_ID);

    // Confirm the PATCH + rollout actually fired (status-only fallback path).
    expect((fetchMock.mock.calls[3][1] as RequestInit).method).toBe('PATCH');
    expect((fetchMock.mock.calls[4][1] as RequestInit).method).toBe('POST');
    expect(String(fetchMock.mock.calls[4][0])).toMatch(/\/rollouts$/);
  });

  it('non-409 status with generic "conflict" message: error propagates, NO PATCH/rollout fallback', async () => {
    // Regression: 'conflict' is too generic to be a race signal — CF uses it
    // in unrelated validation errors. Without status 409 and without a known
    // race phrase ("already exists" / "duplicate"), the error must propagate
    // so an operator can diagnose, not silently fall through to PATCH.
    fetchMock.mockResolvedValueOnce(cfSuccess([]));
    fetchMock.mockResolvedValueOnce(
      cfError('configuration conflicts with durable object namespace', 400),
    );

    await expect(upsertSandboxContainerApplication(ACCOUNT, TOKEN, BASE_CONFIG)).rejects.toThrow(
      /configuration conflicts with durable object namespace/i,
    );

    // find + POST only — no re-find, no PATCH, no rollout.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(init?.method ?? 'GET').not.toBe('PATCH');
      const url = String(call[0]);
      expect(url).not.toMatch(/\/rollouts$/);
    }
  });

  it('non-409 status with "already exists" body: defense-in-depth message fallback still triggers PATCH', async () => {
    // Defense-in-depth case: CF returns a non-409 status (e.g. 400) but the
    // body message contains a known race phrase. The message-matching
    // fallback must keep working for non-conventional CF responses.
    const stale = makeApp({
      configuration: { image: 'old-image:2', instance_type: 'lite' },
      max_instances: 20,
    });

    fetchMock.mockResolvedValueOnce(cfSuccess([]));
    fetchMock.mockResolvedValueOnce(cfError('application with this name already exists', 400));
    fetchMock.mockResolvedValueOnce(cfSuccess([stale]));
    fetchMock.mockResolvedValueOnce(
      cfSuccess(
        makeApp({
          configuration: { image: IMAGE, instance_type: 'lite' },
          max_instances: 20,
        }),
      ),
    );
    fetchMock.mockResolvedValueOnce(cfSuccess({ id: 'rollout-4' }));

    const result = await upsertSandboxContainerApplication(ACCOUNT, TOKEN, BASE_CONFIG);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(result.id).toBe(APP_ID);
    expect((fetchMock.mock.calls[3][1] as RequestInit).method).toBe('PATCH');
  });
});
