import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readBuildOutput } from '@cloudflare/build-output-utils';
import { dirname, join } from 'pathslash';
import { afterEach, expect, it } from 'vite-plus/test';
import { prepareCfBuildOutput } from '../../src/cli/cf-build-output.ts';

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function worker(config: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-build-output-test-'));
  roots.push(root);
  const output = join(root, 'dist', 'ssr');
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, 'index.js'),
    'export default { fetch() { return new Response("ok") } };\n',
  );
  writeFileSync(join(output, 'wrangler.json'), JSON.stringify(config));
  return output;
}

it('produces deployable cf build output without changing the authored project', async () => {
  const output = worker({
    name: 'void-test',
    compatibility_date: '2026-09-29',
    main: 'index.js',
    vars: { MESSAGE: 'hello' },
    kv_namespaces: [{ binding: 'CACHE', id: 'namespace-id' }],
    d1_databases: [{ binding: 'DB', database_id: 'database-id', database_name: 'database' }],
    triggers: { crons: ['0 * * * *'] },
    assets: { binding: 'ASSETS', directory: '../client', run_worker_first: ['/**'] },
  });
  const client = join(dirname(output), 'client');
  mkdirSync(client);
  writeFileSync(join(client, 'index.html'), '<h1>hello</h1>');
  const prepared = await prepareCfBuildOutput(output, 'account-id');
  expect(prepared).not.toBeNull();
  if (!prepared) {
    return;
  }
  try {
    const built = await readBuildOutput(prepared.directory);
    expect(built.rootConfig.accountId).toBe('account-id');
    expect(built.workers.default.config.env?.CACHE).toEqual({ type: 'kv', id: 'namespace-id' });
    expect(built.workers.default.config.manifest?.mainModule).toBe('index.js');
    expect(built.workers.default.assetsDir).toBeDefined();
    const cf = join(dirname(fileURLToPath(import.meta.resolve('cf/package.json'))), 'bin', 'cf');
    const dryRun = spawnSync(
      process.execPath,
      [cf, 'workers', 'versions', 'create', '--prebuilt', '--dry-run'],
      {
        cwd: prepared.directory,
        encoding: 'utf8',
      },
    );
    expect(dryRun.status, `${dryRun.stdout}\n${dryRun.stderr}`).toBe(0);
    expect(dryRun.stdout).toContain('Dry run complete');
  } finally {
    prepared.dispose();
  }
  expect(existsSync(prepared.directory)).toBe(false);
  expect(existsSync(join(output, 'wrangler.json'))).toBe(true);
});

it('keeps unsupported configuration on the existing deploy path', async () => {
  const output = worker({
    name: 'void-test',
    compatibility_date: '2026-09-29',
    main: 'index.js',
    limits: { cpu_ms: 100 },
  });
  expect(await prepareCfBuildOutput(output, 'account-id')).toBeNull();
});
