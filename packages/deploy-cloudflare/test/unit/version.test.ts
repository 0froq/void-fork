import { describe, expect, it, vi } from 'vite-plus/test';
import {
  activateCloudflareVersion,
  encodeCloudflareVersionMessage,
  parseCloudflareVersionMessage,
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
  rollback?: CloudflareCommandResult;
}) {
  let deployCalls = 0;
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
    if (args[0] === 'deploy') {
      return overrides?.bootstrap ?? ok();
    }
    if (args[0] === 'triggers') {
      return overrides?.triggers ?? ok();
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  });
}

describe('Cloudflare version activation', () => {
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
      message: encodeCloudflareVersionMessage(['0001_init.sql']),
      fetch: fetcher,
      sleep: async () => {},
    });

    expect(result).toEqual({
      ok: true,
      versionId: NEXT,
      previewUrl: 'https://ready.example.workers.dev',
      previousVersionId: CURRENT,
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
    expect(runWrangler.mock.calls[2]![0]).toContain(`${NEXT}@100`);
    expect(runWrangler.mock.calls[3]![0]).toEqual([
      'triggers',
      'deploy',
      '-c',
      '/app/wrangler.jsonc',
      '--env=',
      '--name',
      'my-worker',
    ]);
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
    expect(runWrangler.mock.calls.at(-1)![0]).toContain(`${CURRENT}@100`);
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
        message: encodeCloudflareVersionMessage(['0001_init.sql']),
        fetch: fetcher,
      }),
    ).resolves.toEqual({
      ok: true,
      versionId: NEXT,
      previewUrl: 'https://first.example.workers.dev',
      previousVersionId: null,
    });
    expect(runWrangler.mock.calls.map(([args]) => args.slice(0, 2))).toEqual([
      ['deployments', 'status'],
      ['versions', 'upload'],
      ['deploy', '-c'],
    ]);
    expect(runWrangler.mock.calls[2]![0]).toContain('--autoconfig=false');
    expect(fetcher).toHaveBeenCalledWith(
      'https://first.example.workers.dev/__void/ready',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
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
});
