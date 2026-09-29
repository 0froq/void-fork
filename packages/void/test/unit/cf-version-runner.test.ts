import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { afterEach, expect, it } from 'vite-plus/test';
import { prepareCfBuildOutput } from '../../src/cli/cf-build-output.ts';
import { createCfVersionRunner } from '../../src/cli/cf-version-runner.ts';

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
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
