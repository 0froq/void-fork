import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  activateCloudflareVersion,
  deployCloudflareVersionTriggers,
  encodeCloudflareVersionMessage,
  extractWorkersDevSubdomain,
  normalizeWorkersDevSubdomain,
  parseCloudflareVersionMessage,
  readCloudflareTriggerConfig,
  type CloudflareCommandResult,
} from '../../src/index.ts';

const CURRENT = '11111111-1111-4111-8111-111111111111';
const NEXT = '22222222-2222-4222-8222-222222222222';

function ok(stdout = ''): CloudflareCommandResult {
  return { stdout, stderr: '', status: 0 };
}

function runner(overrides?: {
  status?: CloudflareCommandResult;
  upload?: CloudflareCommandResult;
  bootstrap?: CloudflareCommandResult;
  activate?: CloudflareCommandResult;
  triggers?: CloudflareCommandResult;
  triggerRollback?: CloudflareCommandResult;
  rollback?: CloudflareCommandResult;
  versions?: CloudflareCommandResult;
}) {
  let deployCalls = 0;
  let triggerCalls = 0;
  return vi.fn((args: Array<string>) => {
    if (args[0] === 'deployments') {
      return (
        overrides?.status ??
        ok(JSON.stringify({ versions: [{ version_id: CURRENT, percentage: 100 }] }))
      );
    }
    if (args[0] === 'versions' && args[1] === 'upload') {
      return (
        overrides?.upload ??
        ok(
          `Worker Version ID: ${NEXT}\nVersion Preview Alias URL: https://ready.example.workers.dev`,
        )
      );
    }
    if (args[0] === 'versions' && args[1] === 'deploy') {
      deployCalls++;
      return deployCalls === 1 ? (overrides?.activate ?? ok()) : (overrides?.rollback ?? ok());
    }
    if (args[0] === 'versions' && args[1] === 'list') {
      return (
        overrides?.versions ??
        ok(
          JSON.stringify([
            {
              id: CURRENT,
              annotations: {
                'workers/message': encodeCloudflareVersionMessage([], {
                  workers_dev: true,
                  preview_urls: true,
                  routes: [],
                  crons: ['0 * * * *'],
                  queueConsumers: [],
                  workflows: [],
                }),
              },
            },
          ]),
        )
      );
    }
    if (args[0] === 'deploy') {
      return overrides?.bootstrap ?? ok();
    }
    if (args[0] === 'triggers') {
      triggerCalls++;
      return triggerCalls === 1
        ? (overrides?.triggers ?? ok())
        : (overrides?.triggerRollback ?? ok());
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  });
}

describe('Cloudflare version activation', () => {
  it('snapshots and restores effective workers.dev and preview URL defaults', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-version-defaults-'));
    const configPath = join(directory, 'wrangler.json');
    try {
      writeFileSync(configPath, '{"name":"app"}\n');
      const triggerConfig = readCloudflareTriggerConfig(configPath);
      expect(triggerConfig.workers_dev).toBe(true);
      expect(triggerConfig.preview_urls).toBe(true);

      writeFileSync(configPath, '{"name":"app","workers_dev":false,"preview_urls":false}\n');
      let applied: Record<string, unknown> | undefined;
      await deployCloudflareVersionTriggers({
        runWrangler: async (args) => {
          const configIndex = args.indexOf('-c');
          applied = JSON.parse(readFileSync(args[configIndex + 1]!, 'utf-8')) as Record<
            string,
            unknown
          >;
          return ok();
        },
        workerName: 'app',
        configPath,
        triggerConfig,
      });
      expect(applied).toMatchObject({ workers_dev: true, preview_urls: true });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('removes queue consumers omitted from the desired trigger snapshot', async () => {
    const calls: Array<Array<string>> = [];
    const result = await deployCloudflareVersionTriggers({
      runWrangler: async (args) => {
        calls.push(args);
        return ok();
      },
      workerName: 'app',
      triggerConfig: {
        workers_dev: true,
        preview_urls: true,
        routes: [],
        crons: [],
        queueConsumers: [],
        workflows: [],
      },
      previousTriggerConfig: {
        workers_dev: true,
        preview_urls: true,
        routes: [],
        crons: [],
        queueConsumers: [{ queue: 'jobs' }],
        workflows: [],
      },
    });

    expect(result.status).toBe(0);
    expect(calls[1]).toEqual([
      'queues',
      'consumer',
      'remove',
      'jobs',
      'app',
      '-c',
      expect.any(String),
      '--env=',
    ]);
  });

  it('clears schedules without deleting removed workflow state', async () => {
    let applied: Record<string, unknown> | undefined;
    await deployCloudflareVersionTriggers({
      runWrangler: async (args) => {
        const configIndex = args.indexOf('-c');
        applied = JSON.parse(readFileSync(args[configIndex + 1]!, 'utf-8')) as Record<
          string,
          unknown
        >;
        return ok();
      },
      workerName: 'app',
      triggerConfig: {
        workers_dev: true,
        preview_urls: true,
        routes: [],
        crons: [],
        queueConsumers: [],
        workflows: [],
      },
      previousTriggerConfig: {
        workers_dev: true,
        preview_urls: true,
        routes: [],
        crons: [],
        queueConsumers: [],
        workflows: [{ name: 'nightly', class_name: 'NightlyWorkflow', schedules: ['0 0 * * *'] }],
      },
    });

    expect(applied?.workflows).toEqual([
      { name: 'nightly', class_name: 'NightlyWorkflow', schedules: [] },
    ]);
  });

  it('publishes an explicit empty set when removing the final custom domain', async () => {
    const publishEmptyCustomDomains = vi.fn(async () => ok());
    const result = await deployCloudflareVersionTriggers({
      runWrangler: async () => ok(),
      workerName: 'app',
      triggerConfig: {
        workers_dev: true,
        preview_urls: true,
        routes: [],
        crons: [],
        queueConsumers: [],
        workflows: [],
      },
      previousTriggerConfig: {
        workers_dev: false,
        preview_urls: false,
        routes: [{ pattern: 'app.example.com', custom_domain: true }],
        crons: [],
        queueConsumers: [],
        workflows: [],
      },
      publishEmptyCustomDomains,
    });

    expect(result.status).toBe(0);
    expect(publishEmptyCustomDomains).toHaveBeenCalledOnce();
  });

  it('normalizes and extracts workers.dev account subdomains', () => {
    expect(normalizeWorkersDevSubdomain('Developer-Platform-Experience.workers.dev/')).toBe(
      'developer-platform-experience',
    );
    expect(normalizeWorkersDevSubdomain('not valid')).toBeUndefined();
    expect(normalizeWorkersDevSubdomain('My-Team.fed.workers.dev')).toBe('my-team.fed');
    expect(
      extractWorkersDevSubdomain(
        'https://void-ready-abc-my-worker.developer-platform-experience.workers.dev/path',
      ),
    ).toBe('developer-platform-experience');
    expect(
      extractWorkersDevSubdomain('https://void-ready-abc-my-worker.my-team.fed.workers.dev/path'),
    ).toBe('my-team.fed');
    expect(extractWorkersDevSubdomain('https://example.com')).toBeUndefined();
    expect(extractWorkersDevSubdomain('https://worker.my-team.other.workers.dev')).toBeUndefined();
  });

  it('round-trips migration metadata and rejects unrelated annotations', () => {
    const message = encodeCloudflareVersionMessage(['0001_init.sql', '0002_users.sql']);
    expect(parseCloudflareVersionMessage(message)).toEqual({
      schema: 1,
      migrations: ['0001_init.sql', '0002_users.sql'],
    });
    expect(parseCloudflareVersionMessage('manual deploy')).toBeNull();
    expect(parseCloudflareVersionMessage('void:{bad')).toBeNull();
  });

  it('uploads, probes, activates, and applies triggers in order', async () => {
    const runWrangler = runner();
    const fetcher = vi.fn(async () => Response.json({ ready: true }));
    const result = await activateCloudflareVersion({
      runWrangler,
      verifyUploader: () => true,
      workerName: 'my-worker',
      configPath: '/app/wrangler.jsonc',
      assetsDirectoryOverride: '/app/.void/deploy/cloudflare/assets',
      message: encodeCloudflareVersionMessage(['0001_init.sql']),
      fetch: fetcher,
      sleep: async () => {},
    });

    expect(result).toEqual({
      ok: true,
      versionId: NEXT,
      previewUrl: 'https://ready.example.workers.dev',
      previousVersionId: CURRENT,
      workersDevSubdomain: 'example',
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://ready.example.workers.dev/__void/ready',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(runWrangler.mock.calls.map(([args]) => args.slice(0, 2))).toEqual([
      ['deployments', 'status'],
      ['versions', 'upload'],
      ['versions', 'deploy'],
      ['triggers', 'deploy'],
    ]);
    expect(runWrangler.mock.calls[1]![0]).toContain('--strict');
    expect(runWrangler.mock.calls[1]![0]).toContain('--assets');
    expect(runWrangler.mock.calls[1]![0]).toContain('/app/.void/deploy/cloudflare/assets');
    expect(runWrangler.mock.calls[2]![0]).toContain(`${NEXT}@100`);
    expect(runWrangler.mock.calls[3]![0]).toEqual([
      'triggers',
      'deploy',
      '-c',
      expect.stringContaining('void-version-triggers-'),
      '--env=',
      '--name',
      'my-worker',
    ]);
  });

  it('uses newer published traffic provenance instead of a stale version annotation', async () => {
    const staleTriggerConfig = {
      workers_dev: false,
      preview_urls: false,
      routes: [{ pattern: 'old.example.com', custom_domain: true }],
      crons: [],
      queueConsumers: [],
      workflows: [],
    };
    const desiredTriggerConfig = {
      ...staleTriggerConfig,
      workers_dev: true,
      preview_urls: true,
      routes: [],
    };
    const runWrangler = runner({
      versions: ok(
        JSON.stringify([
          {
            id: CURRENT,
            annotations: {
              'workers/message': encodeCloudflareVersionMessage([], staleTriggerConfig),
            },
          },
        ]),
      ),
    });
    const publishEmptyCustomDomains = vi.fn(async () => ok());

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([], desiredTriggerConfig),
        previousTrafficConfig: {
          workers_dev: true,
          preview_urls: true,
          routes: [],
        },
        publishEmptyCustomDomains,
        fetch: async () => Response.json({ ready: true }),
        sleep: async () => {},
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(publishEmptyCustomDomains).not.toHaveBeenCalled();
  });

  it('does not activate a version whose preview never becomes ready', async () => {
    const runWrangler = runner();
    const result = await activateCloudflareVersion({
      runWrangler,
      verifyUploader: () => true,
      workerName: 'my-worker',
      message: encodeCloudflareVersionMessage([]),
      fetch: async () => new Response('not ready', { status: 503 }),
      sleep: async () => {},
      readinessAttempts: 2,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'readiness-failed',
      versionId: NEXT,
      rollback: 'not-needed',
    });
    expect(runWrangler.mock.calls.some(([args]) => args[1] === 'deploy')).toBe(false);
  });

  it('sends Access service-token headers only to the matching Workers preview host', async () => {
    const runWrangler = runner({
      upload: ok(
        `Worker Version ID: ${NEXT}\nVersion Preview Alias URL: https://void-ready-abc-my-worker.developer-platform-experience.workers.dev`,
      ),
    });
    const fetcher = vi.fn(async () => Response.json({ ready: true }));

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        workersDevSubdomain: 'attacker-account',
        message: encodeCloudflareVersionMessage([]),
        readinessHeaders: {
          'CF-Access-Client-Id': 'service-id',
          'CF-Access-Client-Secret': 'service-secret',
        },
        fetch: fetcher,
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(fetcher).toHaveBeenCalledWith(
      'https://void-ready-abc-my-worker.developer-platform-experience.workers.dev/__void/ready',
      expect.objectContaining({
        headers: expect.objectContaining({
          'CF-Access-Client-Id': 'service-id',
          'CF-Access-Client-Secret': 'service-secret',
        }),
        redirect: 'manual',
      }),
    );
  });

  it('never forwards Access service-token headers to an unrelated readiness host', async () => {
    const runWrangler = runner({
      upload: ok(`Worker Version ID: ${NEXT}\nVersion Preview Alias URL: https://attacker.example`),
    });
    const fetcher = vi.fn(async () => Response.json({ ready: true }));

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([]),
        readinessHeaders: {
          'CF-Access-Client-Id': 'service-id',
          'CF-Access-Client-Secret': 'service-secret',
        },
        fetch: fetcher,
        sleep: async () => {},
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'readiness-failed' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('falls back from an Access-blocked preview alias to the stable Worker hostname', async () => {
    const runWrangler = runner({
      upload: ok(
        `Worker Version ID: ${NEXT}\nVersion Preview Alias URL: https://void-ready-abc-my-worker.developer-platform-experience.workers.dev`,
      ),
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('error code: 1050', { status: 403 }))
      .mockResolvedValueOnce(Response.json({ ready: true }));

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([]),
        fetch: fetcher,
        sleep: async () => {},
      }),
    ).resolves.toMatchObject({
      ok: true,
      versionId: NEXT,
      previewUrl: 'https://my-worker.developer-platform-experience.workers.dev',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith(
      'https://my-worker.developer-platform-experience.workers.dev/__void/ready',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Cloudflare-Workers-Version-Overrides': `my-worker="${NEXT}"`,
        }),
      }),
    );
    expect(runWrangler.mock.calls[2]![0]).toEqual(
      expect.arrayContaining([`${CURRENT}@100`, `${NEXT}@0`]),
    );
    expect(runWrangler.mock.calls[3]![0]).toContain(`${NEXT}@100`);
  });

  it('never sends Access headers to an unverified cached workers.dev subdomain', async () => {
    const runWrangler = runner({ upload: ok(`Worker Version ID: ${NEXT}`) });
    const fetcher = vi.fn(async () => Response.json({ ready: true }));

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        workersDevSubdomain: 'stale-or-attacker',
        message: encodeCloudflareVersionMessage([]),
        readinessHeaders: { 'CF-Access-Token': 'secret' },
        fetch: fetcher,
        readinessAttempts: 1,
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'readiness-failed' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('restores the prior deployment when Access blocks both readiness hostnames', async () => {
    const runWrangler = runner({
      upload: ok(
        `Worker Version ID: ${NEXT}\nVersion Preview Alias URL: https://void-ready-abc-my-worker.developer-platform-experience.workers.dev`,
      ),
    });
    const fetcher = vi.fn(async () => new Response('error code: 1050', { status: 403 }));

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([]),
        fetch: fetcher,
        sleep: async () => {},
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'readiness-access-denied',
      rollback: 'succeeded',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(runWrangler.mock.calls[2]![0]).toEqual(
      expect.arrayContaining([`${CURRENT}@100`, `${NEXT}@0`]),
    );
    expect(runWrangler.mock.calls[3]![0]).toContain(`${CURRENT}@100`);
    expect(runWrangler.mock.calls.some(([args]) => args[0] === 'triggers')).toBe(false);
  });

  it('leaves a first uploaded version inactive when its preview alias is Access-blocked', async () => {
    const runWrangler = runner({
      status: { stdout: '', stderr: 'The Worker first has no deployments.', status: 1 },
      upload: ok(
        `Worker Version ID: ${NEXT}\nVersion Preview Alias URL: https://void-ready-abc-first.developer-platform-experience.workers.dev`,
      ),
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'first',
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => new Response('error code: 1050', { status: 403 }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'readiness-access-denied',
      rollback: 'not-needed',
    });
    expect(runWrangler.mock.calls.some(([args]) => args[1] === 'deploy')).toBe(false);
  });

  it('refuses to flatten an existing gradual traffic split', async () => {
    const runWrangler = runner({
      status: ok(
        JSON.stringify({
          versions: [
            { version_id: CURRENT, percentage: 90 },
            { version_id: NEXT, percentage: 10 },
          ],
        }),
      ),
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toEqual({ ok: false, reason: 'traffic-split-unsupported' });
    expect(runWrangler).toHaveBeenCalledTimes(1);
  });

  it('verifies the uploader before reading credentialed deployment status', async () => {
    const runWrangler = runner();

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => false,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toEqual({ ok: false, reason: 'uploader-changed' });
    expect(runWrangler).not.toHaveBeenCalled();
  });

  it('fails closed when Wrangler does not return a preview URL', async () => {
    const runWrangler = runner({ upload: ok(`Worker Version ID: ${NEXT}`) });
    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'preview-unavailable', versionId: NEXT });
  });

  it('probes a zero-percent Durable Object version through a production workers.dev URL', async () => {
    const runWrangler = runner({ upload: ok(`Worker Version ID: ${NEXT}`) });
    const fetcher = vi.fn(async () => Response.json({ ready: true }));

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        workersDevSubdomain: 'developer-platform-experience',
        message: encodeCloudflareVersionMessage([]),
        fetch: fetcher,
      }),
    ).resolves.toMatchObject({
      ok: true,
      versionId: NEXT,
      previewUrl: 'https://my-worker.developer-platform-experience.workers.dev',
    });

    expect(runWrangler.mock.calls.map(([args]) => args.slice(0, 2))).toEqual([
      ['deployments', 'status'],
      ['versions', 'upload'],
      ['versions', 'deploy'],
      ['versions', 'deploy'],
      ['triggers', 'deploy'],
    ]);
    expect(runWrangler.mock.calls[2]![0]).toEqual(
      expect.arrayContaining([`${CURRENT}@100`, `${NEXT}@0`]),
    );
    expect(runWrangler.mock.calls[3]![0]).toContain(`${NEXT}@100`);
    expect(fetcher).toHaveBeenCalledWith(
      'https://my-worker.developer-platform-experience.workers.dev/__void/ready',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Cloudflare-Workers-Version-Overrides': `my-worker="${NEXT}"`,
        }),
      }),
    );
  });

  it('restores the prior deployment when a zero-percent version is not ready', async () => {
    const runWrangler = runner({ upload: ok(`Worker Version ID: ${NEXT}`) });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        workersDevSubdomain: 'developer-platform-experience',
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => new Response('not ready', { status: 503 }),
        sleep: async () => {},
        readinessAttempts: 1,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'readiness-failed',
      rollback: 'succeeded',
    });

    expect(runWrangler.mock.calls[2]![0]).toEqual(
      expect.arrayContaining([`${CURRENT}@100`, `${NEXT}@0`]),
    );
    expect(runWrangler.mock.calls[3]![0]).toContain(`${CURRENT}@100`);
    expect(runWrangler.mock.calls.some(([args]) => args[0] === 'triggers')).toBe(false);
  });

  it('does not invoke a changed uploader to restore zero-percent staging', async () => {
    const runWrangler = runner({ upload: ok(`Worker Version ID: ${NEXT}`) });
    let verification = 0;

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => ++verification < 4,
        workerName: 'my-worker',
        workersDevSubdomain: 'developer-platform-experience',
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => new Response('not ready', { status: 503 }),
        sleep: async () => {},
        readinessAttempts: 1,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'readiness-failed',
      rollback: 'unsafe',
    });

    expect(runWrangler.mock.calls.map(([args]) => args[0])).toEqual([
      'deployments',
      'versions',
      'versions',
    ]);
  });

  it('bootstraps a proven first deploy when account preview URLs are disabled', async () => {
    const runWrangler = runner({
      upload: ok(`Worker Version ID: ${NEXT}`),
      bootstrap: ok(`Current Version ID: ${NEXT}\nhttps://first.example.workers.dev`),
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'first-with-secret',
        message: encodeCloudflareVersionMessage([]),
        allowFirstDeploymentBootstrap: true,
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true, previewUrl: 'https://first.example.workers.dev' });
    expect(runWrangler.mock.calls.map(([args]) => args[0])).toEqual([
      'deployments',
      'versions',
      'deploy',
    ]);
  });

  it('rolls traffic back when trigger activation fails', async () => {
    const runWrangler = runner({ triggers: { ...ok(), status: 1 } });
    const result = await activateCloudflareVersion({
      runWrangler,
      verifyUploader: () => true,
      workerName: 'my-worker',
      message: encodeCloudflareVersionMessage([]),
      fetch: async () => Response.json({ ready: true }),
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'triggers-failed',
      rollback: 'succeeded',
      previousVersionId: CURRENT,
    });
    expect(
      runWrangler.mock.calls.some(([args]) =>
        args.some((argument) => argument === `${CURRENT}@100`),
      ),
    ).toBe(true);
    expect(runWrangler.mock.calls.at(-1)![0].slice(0, 2)).toEqual(['triggers', 'deploy']);
  });

  it('does not claim trigger rollback succeeded without prior trigger metadata', async () => {
    const runWrangler = runner({
      triggers: { ...ok(), status: 1 },
      versions: ok(
        JSON.stringify([
          {
            id: CURRENT,
            annotations: { 'workers/message': encodeCloudflareVersionMessage([]) },
          },
        ]),
      ),
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'triggers-failed',
      rollback: 'unavailable',
    });
    expect(runWrangler.mock.calls.filter(([args]) => args[0] === 'triggers')).toHaveLength(1);
  });

  it('does not invoke a changed uploader to roll traffic back after activation', async () => {
    const runWrangler = runner();
    let verification = 0;
    const result = await activateCloudflareVersion({
      runWrangler,
      verifyUploader: () => ++verification < 4,
      workerName: 'my-worker',
      message: encodeCloudflareVersionMessage([]),
      fetch: async () => Response.json({ ready: true }),
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'uploader-changed',
      rollback: 'unsafe',
      previousVersionId: CURRENT,
    });
    expect(runWrangler.mock.calls.at(-1)![0]).toContain(`${NEXT}@100`);
    expect(runWrangler.mock.calls.some(([args]) => args[0] === 'triggers')).toBe(false);
  });

  it('accepts the first deployment when status reports no deployments', async () => {
    const runWrangler = runner({
      status: { stdout: '', stderr: 'The Worker first has no deployments.', status: 1 },
    });
    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'first',
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true, previousVersionId: null });
  });

  it('accepts Wrangler error 10007 as a Worker that has not been created yet', async () => {
    const runWrangler = runner({
      status: {
        stdout: '',
        stderr: 'This Worker does not exist on your account. [code: 10007]',
        status: 1,
      },
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'first',
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true, previousVersionId: null });
  });

  it('bootstraps first-deploy Durable Object migrations through a non-versioned deploy', async () => {
    const runWrangler = runner({
      status: { stdout: '', stderr: 'The Worker first has no deployments.', status: 1 },
      upload: {
        stdout: '',
        stderr: 'Durable Object migrations require deploy. [code: 10211]',
        status: 1,
      },
      bootstrap: ok(`Current Version ID: ${NEXT}\nhttps://first.example.workers.dev`),
    });
    const fetcher = vi.fn(async () => Response.json({ ready: true }));

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'first',
        configPath: '/app/wrangler.jsonc',
        assetsDirectoryOverride: '/app/.void/deploy/cloudflare/assets',
        message: encodeCloudflareVersionMessage(['0001_init.sql']),
        fetch: fetcher,
      }),
    ).resolves.toEqual({
      ok: true,
      versionId: NEXT,
      previewUrl: 'https://first.example.workers.dev',
      previousVersionId: null,
      workersDevSubdomain: 'example',
    });
    expect(runWrangler.mock.calls.map(([args]) => args.slice(0, 2))).toEqual([
      ['deployments', 'status'],
      ['versions', 'upload'],
      ['deploy', '-c'],
    ]);
    expect(runWrangler.mock.calls[2]![0]).toContain('--autoconfig=false');
    expect(runWrangler.mock.calls[2]![0]).toContain('--assets');
    expect(runWrangler.mock.calls[2]![0]).toContain('/app/.void/deploy/cloudflare/assets');
    expect(fetcher).toHaveBeenCalledWith(
      'https://first.example.workers.dev/__void/ready',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('reports Access blocking the already-active first Worker bootstrap', async () => {
    const runWrangler = runner({
      status: { stdout: '', stderr: 'The Worker first has no deployments.', status: 1 },
      upload: {
        stdout: '',
        stderr: 'Durable Object migrations require deploy. [code: 10211]',
        status: 1,
      },
      bootstrap: ok(`Current Version ID: ${NEXT}\nhttps://first.example.workers.dev`),
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'first',
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => new Response('error code: 1050', { status: 403 }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'bootstrap-readiness-access-denied',
      rollback: 'unavailable',
    });
  });

  it('bootstraps a Worker that the Versions API cannot create', async () => {
    const runWrangler = runner({
      status: { stdout: '', stderr: 'This Worker does not exist. [code: 10007]', status: 1 },
      upload: {
        stdout: '',
        stderr:
          'You cannot upload a new version of a Worker that does not yet exist. Please run the `deploy` command first.',
        status: 1,
      },
      bootstrap: ok(`Current Version ID: ${NEXT}\nhttps://first.example.workers.dev`),
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'first-static',
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true, previousVersionId: null });
    expect(runWrangler.mock.calls.map(([args]) => args[0])).toEqual([
      'deployments',
      'versions',
      'deploy',
    ]);
  });

  it('never falls back to non-versioned deployment for an existing Worker', async () => {
    const runWrangler = runner({
      upload: {
        stdout: '',
        stderr: 'Durable Object migrations require deploy. [code: 10211]',
        status: 1,
      },
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'existing',
        message: encodeCloudflareVersionMessage(['0002_state.sql']),
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'upload-failed',
      status: 1,
      cloudflareErrorCode: 10211,
    });
    expect(runWrangler.mock.calls.some(([args]) => args[0] === 'deploy')).toBe(false);
  });

  it('classifies a Containers entitlement failure during version upload', async () => {
    const runWrangler = runner({
      upload: {
        stdout: '',
        stderr:
          'Authentication error [GET https://api.cloudflare.com/client/v4/accounts/acc/containers/me] status: 403',
        status: 1,
      },
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'sandbox-app',
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'upload-failed',
      status: 1,
      containersUnavailable: true,
    });
  });

  it('classifies a Containers entitlement failure during first-deploy bootstrap', async () => {
    const runWrangler = runner({
      status: { stdout: '', stderr: 'This Worker does not exist. [code: 10007]', status: 1 },
      upload: {
        stdout: '',
        stderr: 'Durable Object migrations require deploy. [code: 10211]',
        status: 1,
      },
      bootstrap: {
        stdout: '',
        stderr:
          'Authentication error [GET https://api.cloudflare.com/client/v4/accounts/acc/containers/me] status: 403',
        status: 1,
      },
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'sandbox-app',
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'bootstrap-failed',
      status: 1,
      containersUnavailable: true,
    });
  });

  it('bootstraps over the placeholder version created while provisioning a first secret', async () => {
    const runWrangler = runner({
      upload: {
        stdout: '',
        stderr: 'Durable Object migrations require deploy. [code: 10211]',
        status: 1,
      },
      bootstrap: ok(`Current Version ID: ${NEXT}\nhttps://first.example.workers.dev`),
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'first-with-secret',
        message: encodeCloudflareVersionMessage(['0001_state.sql']),
        allowFirstDeploymentBootstrap: true,
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true, previousVersionId: CURRENT });
    expect(runWrangler.mock.calls.some(([args]) => args[0] === 'deploy')).toBe(true);
  });
});
