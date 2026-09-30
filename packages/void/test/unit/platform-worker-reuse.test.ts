import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeCloudflareVersionMessage,
  readCloudflareTriggerConfig,
} from '@void/deploy-cloudflare';
import { expect, it, vi } from 'vite-plus/test';
import {
  deployPlatformWorker,
  platformWorkerUploadFingerprint,
} from '../../src/cli/platform-installer.ts';

const VERSION = '11111111-1111-4111-8111-111111111111';

async function attemptReuse(input: {
  annotationHash?: string;
  missingAnnotationHash?: boolean;
  changeConfig?: boolean;
  changeScript?: boolean;
  secrets?: Record<string, string> | null;
  versionDrift?: boolean;
}) {
  const directory = mkdtempSync(join(tmpdir(), 'void-worker-reuse-'));
  const calls: Array<string> = [];
  const onTrafficPublished = vi.fn(async () => {});
  try {
    const main = join(directory, 'worker.js');
    const configPath = join(directory, 'wrangler.json');
    const marker = 'owned-by-test';
    const config = {
      account_id: 'account',
      compatibility_date: '2026-09-30',
      main,
      name: 'void-test-api',
      preview_urls: false,
      vars: { PLATFORM_OWNERSHIP_MARKER: marker, VERSION: 'one' },
      workers_dev: true,
    };
    writeFileSync(main, 'export default { fetch() { return new Response("one"); } };');
    writeFileSync(configPath, JSON.stringify(config));
    const originalHash = platformWorkerUploadFingerprint(config);
    expect(originalHash).toMatch(/^[a-f0-9]{64}$/);
    const triggers = readCloudflareTriggerConfig(configPath);
    if (input.changeScript) {
      writeFileSync(main, 'export default { fetch() { return new Response("two"); } };');
    }
    const desiredConfig = input.changeConfig
      ? { ...config, vars: { ...config.vars, VERSION: 'two' } }
      : config;
    let statusReads = 0;
    const runner = async (args: ReadonlyArray<string>) => {
      calls.push(args.slice(0, 2).join(' '));
      if (args[0] === 'deployments' && args[1] === 'status') {
        statusReads++;
        return {
          status: 0,
          stderr: '',
          stdout: JSON.stringify({
            versions: [
              {
                percentage: 100,
                version_id:
                  input.versionDrift && statusReads > 1
                    ? '22222222-2222-4222-8222-222222222222'
                    : VERSION,
              },
            ],
          }),
        };
      }
      if (args[0] === 'versions' && args[1] === 'view') {
        return {
          status: 0,
          stderr: '',
          stdout: JSON.stringify({
            annotations: {
              'workers/message': encodeCloudflareVersionMessage(
                [],
                triggers,
                input.missingAnnotationHash ? undefined : (input.annotationHash ?? originalHash!),
              ),
            },
            resources: {
              bindings: [{ name: 'PLATFORM_OWNERSHIP_MARKER', type: 'plain_text', text: marker }],
            },
          }),
        };
      }
      if (args[0] === 'deployments' && args[1] === 'list') {
        return {
          status: 0,
          stderr: '',
          stdout: JSON.stringify([
            {
              created_on: '2026-09-30T00:00:00.000Z',
              id: 'deployment-one',
              versions: [{ percentage: 100, version_id: VERSION }],
            },
          ]),
        };
      }
      if (args[0] === 'triggers' && args[1] === 'deploy') {
        return { status: 0, stderr: '', stdout: '' };
      }
      if (args[0] === 'versions' && args[1] === 'upload') {
        return { status: 1, stderr: 'upload reached', stdout: '' };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    };
    const operation = deployPlatformWorker(desiredConfig, input.secrets ?? null, {
      apiBaseUrl: 'https://api.cloudflare.com/client/v4',
      inspectNewWorker: async () => 'owned',
      managedRoutes: [],
      onStaged: async () => {},
      onTrafficPublished,
      onUnsafeTraffic: async () => {},
      preservedRoutes: [],
      previousConfig: config,
      previousPublicEndpoints: true,
      publishCustomDomains: async () => {},
      publishRoutes: async () => {},
      removeCustomDomains: async () => {},
      retainNewWorker: async () => {},
      runner,
      workerExisted: true,
    });
    const outcome = await operation.then(
      (value) => ({ error: null, value }),
      (error: unknown) => ({ error, value: null }),
    );
    return { calls, onTrafficPublished, ...outcome };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it('reconciles traffic without uploading an identical active Worker version', async () => {
  const run = await attemptReuse({});
  expect(run.error).toBeNull();
  expect(run.value).toBeNull();
  expect(run.calls).not.toContain('versions upload');
  expect(run.calls).toContain('triggers deploy');
  expect(run.onTrafficPublished).toHaveBeenCalledOnce();
});

it.each([
  { changeConfig: true },
  { changeScript: true },
  { secrets: { TOKEN: 'changed' } },
  { annotationHash: 'f'.repeat(64) },
  { missingAnnotationHash: true },
])('uploads when the active version does not prove identical input: %j', async (input) => {
  const run = await attemptReuse(input);
  expect(String(run.error)).toContain('upload reached');
  expect(run.calls).toContain('versions upload');
});

it('fails closed when the active version changes during inspection', async () => {
  const run = await attemptReuse({ versionDrift: true });
  expect(String(run.error)).toContain('changed concurrently');
  expect(run.calls).not.toContain('versions upload');
});
