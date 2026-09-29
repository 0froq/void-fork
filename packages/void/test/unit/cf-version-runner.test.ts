import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { afterEach, expect, it } from 'vite-plus/test';
import { activateCloudflareVersion } from '../../../deploy-cloudflare/src/version.ts';
import { prepareCfBuildOutput } from '../../src/cli/cf-build-output.ts';
import { createCfCommand, createCfVersionRunner } from '../../src/cli/cf-version-runner.ts';

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it('preserves real cf provider codes so a missing Worker can reach its first upload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-missing-worker-'));
  roots.push(root);
  const requests: Array<string> = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    request.resume();
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        success: false,
        errors: [{ code: 10007, message: 'The given script does not exist.' }],
        result: null,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`;
    const script = `
      import { createCfCommand } from ${JSON.stringify(new URL('../../src/cli/cf-version-runner.ts', import.meta.url).href)};
      const command = createCfCommand({
        accountId: 'test-account', apiBaseUrl: ${JSON.stringify(apiBaseUrl)},
        env: () => process.env, verifyUploader: () => true,
      });
      console.log(JSON.stringify(command(
        ['workers', 'deployments', 'list', '--worker', 'missing-worker'],
        { cwd: ${JSON.stringify(root)}, capture: true },
      )));
    `;
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        ['--input-type=module', '-e', script],
        {
          cwd: root,
          timeout: 20_000,
          env: {
            PATH: process.env.PATH,
            SYSTEMROOT: process.env.SYSTEMROOT,
            WINDIR: process.env.WINDIR,
            TMP: process.env.TMP,
            TEMP: process.env.TEMP,
            CI: 'true',
            CLOUDFLARE_API_TOKEN: 'synthetic-token',
            CLOUDFLARE_ACCOUNT_ID: 'test-account',
            CLOUDFLARE_API_BASE_URL: apiBaseUrl,
          },
        },
        (error, stdout, stderr) => (error ? reject(new Error(stderr)) : resolve(stdout)),
      );
    });
    const missing = JSON.parse(stdout);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('[code: 10007]');
    expect(requests).toEqual([
      '/client/v4/accounts/test-account/workers/scripts/missing-worker/deployments',
    ]);
    const operations: Array<string> = [];
    const result = await activateCloudflareVersion({
      workerName: 'missing-worker',
      message: 'review',
      verifyUploader: () => true,
      verifyInheritedSecrets: true,
      runWrangler: (args) => {
        operations.push(args.slice(0, 2).join(' '));
        return args[1] === 'upload'
          ? { status: 1, stdout: '', stderr: 'Test stopped before uploading.' }
          : missing;
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'upload-failed' });
    expect(operations).toEqual(['deployments status', 'versions list', 'versions upload']);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('treats a verified empty deployment list as missing but rejects malformed status', async () => {
  const prepared = await output();
  try {
    for (const body of [{ deployments: [] }, {}]) {
      const calls: Array<Array<string>> = [];
      const runner = createCfVersionRunner({
        output: prepared,
        workerName: 'void-test',
        runCf: (args) => {
          calls.push(args);
          return args[1] === 'deployments'
            ? { status: 0, stdout: JSON.stringify(body), stderr: '' }
            : { status: 1, stdout: '', stderr: 'Test stopped before uploading.' };
        },
      });
      const result = await activateCloudflareVersion({
        workerName: 'void-test',
        message: 'review',
        verifyUploader: () => true,
        runWrangler: runner,
      });
      expect(result).toMatchObject({
        ok: false,
        reason: 'deployments' in body ? 'upload-failed' : 'status-failed',
      });
      expect(calls).toHaveLength('deployments' in body ? 2 : 1);
    }
  } finally {
    prepared.dispose();
  }
});

async function output() {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-runner-test-'));
  roots.push(root);
  const worker = join(root, 'dist', 'ssr');
  mkdirSync(worker, { recursive: true });
  writeFileSync(join(worker, 'index.js'), 'export default { fetch: () => new Response("ok") };');
  writeFileSync(
    join(worker, 'wrangler.json'),
    JSON.stringify({
      name: 'void-test',
      compatibility_date: '2026-09-29',
      main: 'index.js',
      workers_dev: true,
    }),
  );
  const prepared = await prepareCfBuildOutput(worker, 'account-id');
  expect(prepared).not.toBeNull();
  return prepared!;
}

it('does not delegate credentialed commands to a project-local cf', () => {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-pinned-command-'));
  roots.push(root);
  const local = join(root, 'node_modules', 'cf');
  mkdirSync(local, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(
    join(local, 'package.json'),
    JSON.stringify({ name: 'cf', version: '0.0.0', bin: { cf: 'fake.cjs' } }),
  );
  writeFileSync(join(local, 'fake.cjs'), 'console.log("UNPINNED_PROJECT_CF_EXECUTED");');
  const command = createCfCommand({
    accountId: 'test-account',
    apiBaseUrl: 'https://api.cloudflare.com/client/v4',
    verifyUploader: () => true,
    env: () => ({ PATH: process.env.PATH, CI: 'true', CLOUDFLARE_API_TOKEN: 'synthetic-token' }),
  });
  const result = command(['--version'], { cwd: root, capture: true });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).not.toContain('UNPINNED_PROJECT_CF_EXECUTED');
  expect(result.stdout).toContain('1.0.0-beta.5');
});

it('preserves activation metadata and sorts cf version history for the existing protocol', async () => {
  const prepared = await output();
  try {
    const calls: Array<Array<string>> = [];
    const runner = createCfVersionRunner({
      output: prepared,
      workerName: 'void-test',
      runCf: (args) => {
        calls.push(args);
        if (args[1] === 'deployments' && args[2] === 'list') {
          return {
            status: 0,
            stdout: JSON.stringify({
              deployments: [{ versions: [{ version_id: 'one', percentage: 100 }] }],
            }),
            stderr: '',
          };
        }
        if (args[1] === 'versions' && args[2] === 'list') {
          return {
            status: 0,
            stdout: JSON.stringify([
              { id: 'two', number: 2 },
              { id: 'one', number: 1 },
            ]),
            stderr: '',
          };
        }
        return {
          status: 0,
          stdout: 'Worker Version ID: 00000000-0000-0000-0000-000000000001',
          stderr: '',
        };
      },
    });
    const common = ['-c', 'generated.json', '--env=', '--name', 'void-test'];
    const deployment = await runner(['deployments', 'status', ...common, '--json'], {
      capture: true,
    });
    expect(JSON.parse(deployment.stdout)).toEqual({
      versions: [{ version_id: 'one', percentage: 100 }],
    });
    const versions = await runner(['versions', 'list', ...common, '--json'], { capture: true });
    expect(JSON.parse(versions.stdout).map((item: { id: string }) => item.id)).toEqual([
      'one',
      'two',
    ]);
    await runner(
      [
        'versions',
        'upload',
        ...common,
        '--message',
        'void:metadata',
        '--preview-alias',
        'void-ready',
        '--strict',
      ],
      { capture: true },
    );
    expect(calls.at(-1)).toEqual([
      'workers',
      'versions',
      'create',
      '--prebuilt',
      '--message',
      'void:metadata',
      '--preview-alias',
      'void-ready',
    ]);
    await runner(
      [
        'versions',
        'deploy',
        '00000000-0000-0000-0000-000000000001@100',
        ...common,
        '--message',
        'void:metadata',
        '--yes',
      ],
      { capture: false },
    );
    const deployArgs = calls.at(-1)!;
    expect(deployArgs.slice(0, 3)).toEqual(['workers', 'deployments', 'create']);
    expect(JSON.parse(deployArgs[deployArgs.indexOf('--body') + 1]!)).toMatchObject({
      strategy: 'percentage',
      annotations: { 'workers/message': 'void:metadata' },
      versions: [{ version_id: '00000000-0000-0000-0000-000000000001', percentage: 100 }],
    });
  } finally {
    prepared.dispose();
  }
});

it('applies the immutable trigger snapshot through a private cf output copy', async () => {
  const prepared = await output();
  const triggerConfig = join(roots[0]!, 'trigger.json');
  writeFileSync(
    triggerConfig,
    JSON.stringify({
      name: 'void-test',
      workers_dev: false,
      preview_urls: true,
      triggers: { crons: ['0 * * * *'] },
    }),
  );
  let privateDirectory = '';
  try {
    const runner = createCfVersionRunner({
      output: prepared,
      workerName: 'void-test',
      runCf: (args, run) => {
        expect(args).toEqual(['workers', 'triggers', 'deploy', '--prebuilt']);
        privateDirectory = run.cwd;
        expect(run.cwd).not.toBe(prepared.directory);
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const result = await runner(
      ['triggers', 'deploy', '-c', triggerConfig, '--env=', '--name', 'void-test'],
      { capture: false },
    );
    expect(result.status).toBe(0);
    expect(existsSync(privateDirectory)).toBe(false);
    expect(existsSync(prepared.directory)).toBe(true);
  } finally {
    prepared.dispose();
  }
});

it('uses cf for Queue triggers, consumer cleanup, and version binding reads', async () => {
  const prepared = await output();
  const triggerConfig = join(roots.at(-1)!, 'legacy-trigger.json');
  writeFileSync(
    triggerConfig,
    JSON.stringify({ name: 'void-test', queues: { consumers: [{ queue: 'jobs' }] } }),
  );
  const calls: Array<Array<string>> = [];
  try {
    const runner = createCfVersionRunner({
      output: prepared,
      workerName: 'void-test',
      runCf: (args) => {
        calls.push(args);
        if (args[0] === 'queues' && args[1] === 'list') {
          return {
            status: 0,
            stdout: JSON.stringify([{ queue_name: 'jobs', queue_id: 'queue-id' }]),
            stderr: '',
          };
        }
        if (args[0] === 'queues' && args[1] === 'consumers' && args[2] === 'list') {
          return {
            status: 0,
            stdout: JSON.stringify([{ script: 'void-test', consumer_id: 'consumer-id' }]),
            stderr: '',
          };
        }
        if (args[0] === 'workers' && args[1] === 'versions' && args[2] === 'get') {
          return {
            status: 0,
            stdout: JSON.stringify({
              id: 'version-id',
              bindings: [{ name: 'SECRET', type: 'secret_text' }],
            }),
            stderr: '',
          };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const invalid = await runner(['versions', 'deploy', 'invalid@100', '--name', 'void-test'], {
      capture: true,
    });
    expect(invalid.status).toBe(1);
    const triggerArgs = ['triggers', 'deploy', '-c', triggerConfig, '--name', 'void-test'];
    expect((await runner(triggerArgs, { capture: false })).status).toBe(0);
    const removeArgs = ['queues', 'consumer', 'remove', 'jobs', 'void-test'];
    expect((await runner(removeArgs, { capture: false })).status).toBe(0);
    const viewArgs = ['versions', 'view', 'version-id', '--name', 'void-test'];
    const version = await runner(viewArgs, { capture: true });
    expect(JSON.parse(version.stdout).resources.bindings).toEqual([
      { name: 'SECRET', type: 'secret_text' },
    ]);
    expect(calls).toContainEqual(['workers', 'triggers', 'deploy', '--prebuilt']);
    expect(calls).toContainEqual([
      'queues',
      'consumers',
      'delete',
      'consumer-id',
      '--queue-id',
      'queue-id',
      '--force',
    ]);
  } finally {
    prepared.dispose();
  }
});

it('accepts only the staged static assets directory already sealed into prebuilt output', async () => {
  const prepared = await output();
  prepared.assetsDirectory = '/staged/assets';
  const calls: Array<Array<string>> = [];
  try {
    const runner = createCfVersionRunner({
      output: prepared,
      workerName: 'void-test',
      runCf: (args) => {
        calls.push(args);
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const common = ['--name', 'void-test', '--assets'];
    expect(
      (await runner(['versions', 'upload', ...common, '/staged/assets'], { capture: true })).status,
    ).toBe(0);
    expect(calls.at(-1)?.slice(0, 4)).toEqual(['workers', 'versions', 'create', '--prebuilt']);
    expect((await runner(['deploy', ...common, '/wrong/assets'], { capture: true })).status).toBe(
      1,
    );
    expect(calls).toHaveLength(1);
  } finally {
    prepared.dispose();
  }
});
