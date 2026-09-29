import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readBuildOutput } from '@cloudflare/build-output-utils';
import { cloudflare } from '@cloudflare/vite-plugin';
import { renderCloudflareStaticEntry } from '@void/deploy-cloudflare';
import { dirname, join } from 'pathslash';
import { createBuilder } from 'vite';
import { afterEach, expect, it } from 'vite-plus/test';
import { prepareCfBuildOutput, prepareCfStaticBuildOutput } from '../../src/cli/cf-build-output.ts';

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

it('preserves additional module types from a real Cloudflare Vite build', async () => {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-additional-modules-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const configPath = join(root, 'wrangler.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      name: 'void-additional-modules',
      main: 'index.js',
      compatibility_date: '2026-09-29',
    }),
  );
  const assets = {
    'message.txt': 'hello',
    'page.html': '<p>hello</p>',
    'query.sql': 'SELECT 1',
    'bytes.bin': Buffer.from([1, 2, 3]),
    'module.wasm': Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
  };
  for (const [name, contents] of Object.entries(assets)) {
    writeFileSync(join(root, name), contents);
  }
  writeFileSync(
    join(root, 'index.js'),
    `import message from './message.txt';
import page from './page.html';
import query from './query.sql';
import bytes from './bytes.bin';
import wasm from './module.wasm';
export default { fetch() {
  return Response.json({ message, page, query, bytes: Array.from(new Uint8Array(bytes)), imports: WebAssembly.Module.imports(wasm) });
} };`,
  );
  const builder = await createBuilder({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [cloudflare({ configPath })],
    build: { sourcemap: true },
  });
  await builder.buildApp();
  const output = join(root, 'dist', 'void_additional_modules');
  const prepared = await prepareCfBuildOutput(output, 'account-id');
  expect(prepared).not.toBeNull();
  if (!prepared) {
    return;
  }
  try {
    const built = await readBuildOutput(prepared.directory);
    const manifest = built.workers.default.config.manifest!;
    expect(manifest.type).toBe('complete');
    expect(manifest.modules['index.js']).toEqual({ type: 'esm' });
    expect(manifest.modules['index.js.map']).toEqual({ type: 'sourcemap' });
    for (const [name, type] of Object.entries({
      message: 'text',
      page: 'text',
      query: 'text',
      bytes: 'data',
      module: 'wasm',
    })) {
      const moduleName = Object.keys(manifest.modules).find((path) =>
        path.startsWith(`assets/${name}-`),
      );
      expect(moduleName).toBeDefined();
      expect(manifest.modules[moduleName!]).toEqual({ type });
      expect(
        readFileSync(
          join(prepared.directory, '.cloudflare/output/v0/workers/default/bundle', moduleName!),
        ),
      ).toEqual(readFileSync(join(output, moduleName!)));
    }
    expect(manifest.modules['.vite/manifest.json']).toBeUndefined();
    const cf = join(dirname(fileURLToPath(import.meta.resolve('cf/package.json'))), 'bin', 'cf');
    const dryRun = spawnSync(
      process.execPath,
      [cf, 'workers', 'versions', 'create', '--prebuilt', '--dry-run'],
      { cwd: prepared.directory, encoding: 'utf8' },
    );
    expect(dryRun.status, `${dryRun.stdout}\n${dryRun.stderr}`).toBe(0);
  } finally {
    prepared.dispose();
  }
});

it('produces deployable cf build output without changing the authored project', async () => {
  const output = worker({
    name: 'void-test',
    compatibility_date: '2026-09-29',
    main: 'index.js',
    send_metrics: false,
    keep_assets: true,
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

it('preserves worker settings that the previous bridge dropped', async () => {
  const output = worker({
    name: 'void-test',
    compatibility_date: '2026-09-29',
    main: 'index.js',
    limits: { cpu_ms: 100 },
    placement: { mode: 'smart' },
  });
  const prepared = await prepareCfBuildOutput(output, 'account-id');
  expect(prepared).not.toBeNull();
  if (!prepared) {
    return;
  }
  try {
    const built = await readBuildOutput(prepared.directory);
    expect(built.workers.default.config.limits).toEqual({ cpuMs: 100 });
    expect(built.workers.default.config.placement).toEqual({ mode: 'smart' });
  } finally {
    prepared.dispose();
  }
});

it('preserves linked Worker variables and secrets in the cf upload', async () => {
  const output = worker({
    name: 'void-test',
    compatibility_date: '2026-09-29',
    main: 'index.js',
    keep_vars: true,
    vars: { EDITED: 'current' },
  });
  const prepared = await prepareCfBuildOutput(output, 'account-id', {
    inheritedBindings: [
      { name: 'PRESERVED', type: 'plain_text', text: 'production' },
      { name: 'STRUCTURED', type: 'json', json: { active: true } },
      { name: 'TOKEN', type: 'secret_text' },
    ],
  });
  expect(prepared).not.toBeNull();
  if (!prepared) {
    return;
  }
  try {
    const built = await readBuildOutput(prepared.directory);
    expect(built.workers.default.config.env).toMatchObject({
      EDITED: { type: 'text', value: 'current' },
      PRESERVED: { type: 'text', value: 'production' },
      STRUCTURED: { type: 'json', value: { active: true } },
      TOKEN: { type: 'secret' },
    });
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
  } finally {
    prepared.dispose();
  }
});

it('deploys Worker Workflow declarations through cf build output', async () => {
  const output = worker({
    name: 'void-test',
    compatibility_date: '2026-09-29',
    main: 'index.js',
    workflows: [
      {
        binding: 'FLOW',
        name: 'void-test-flow',
        class_name: 'Flow',
        schedules: '0 * * * *',
        limits: { steps: 100 },
      },
    ],
  });
  writeFileSync(
    join(output, 'index.js'),
    'export class Flow { async run() {} }\nexport default { fetch() { return new Response("ok") } };\n',
  );
  const prepared = await prepareCfBuildOutput(output, 'account-id');
  expect(prepared).not.toBeNull();
  if (!prepared) {
    return;
  }
  try {
    const built = await readBuildOutput(prepared.directory);
    expect(built.workers.default.config.env?.FLOW).toEqual({
      type: 'workflow',
      name: 'void-test-flow',
      worker: 'void-test',
      exportName: 'Flow',
    });
    expect(built.workers.default.config.exports?.Flow).toEqual({
      type: 'workflow',
      name: 'void-test-flow',
      schedules: '0 * * * *',
      limits: { steps: 100 },
    });
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
  } finally {
    prepared.dispose();
  }
});

it('copies an internal symlinked Worker module into the prebuilt artifact', async () => {
  const output = worker({
    name: 'void-test',
    compatibility_date: '2026-09-29',
    main: 'index.js',
  });
  symlinkSync('index.js', join(output, 'chunk.js'));
  const prepared = await prepareCfBuildOutput(output, 'account-id');
  expect(prepared).not.toBeNull();
  if (!prepared) {
    return;
  }
  try {
    const built = await readBuildOutput(prepared.directory);
    expect(built.workers.default.config.manifest?.modules['chunk.js']).toEqual({ type: 'esm' });
    expect(
      existsSync(join(prepared.directory, '.cloudflare/output/v0/workers/default/bundle/chunk.js')),
    ).toBe(true);
  } finally {
    prepared.dispose();
  }
});

it('keeps Durable Objects, Queue triggers, and Containers in cf prebuilt output', async () => {
  const output = worker({
    name: 'void-test',
    compatibility_date: '2026-09-29',
    main: 'index.js',
    durable_objects: { bindings: [{ name: 'COUNTER', class_name: 'Counter' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Counter'] }],
    containers: [
      { name: 'counter-container', class_name: 'Counter', image: 'docker.io/example/counter:1' },
    ],
    queues: {
      producers: [{ binding: 'JOBS', queue: 'jobs' }],
      consumers: [{ queue: 'jobs', max_batch_size: 10 }],
    },
  });
  const prepared = await prepareCfBuildOutput(output, 'account-id');
  expect(prepared).not.toBeNull();
  if (!prepared) {
    return;
  }
  try {
    const built = await readBuildOutput(prepared.directory);
    expect(built.workers.default.config.exports?.Counter).toEqual(
      expect.objectContaining({ type: 'durable-object', storage: 'sqlite' }),
    );
    expect(built.workers.default.config.env?.COUNTER).toEqual({
      type: 'unsafe:durable_object_namespace',
      class_name: 'Counter',
    });
    expect(built.workers.default.config.triggers).toContainEqual(
      expect.objectContaining({ type: 'queue', name: 'jobs' }),
    );
    expect(built.containers).toHaveLength(1);
    const cf = join(dirname(fileURLToPath(import.meta.resolve('cf/package.json'))), 'bin', 'cf');
    const dryRun = spawnSync(
      process.execPath,
      [cf, 'workers', 'versions', 'create', '--prebuilt', '--dry-run'],
      { cwd: prepared.directory, encoding: 'utf8' },
    );
    expect(dryRun.status, `${dryRun.stdout}\n${dryRun.stderr}`).toBe(0);
  } finally {
    prepared.dispose();
  }
});

it('bundles a generated static Worker and staged assets into prebuilt cf output', async () => {
  const root = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.tmp-cf-static-'));
  roots.push(root);
  const generated = join(root, '.void', 'deploy', 'cloudflare');
  const assets = join(generated, 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, 'index.html'), '<h1>static</h1>');
  writeFileSync(
    join(generated, 'static-edge.mjs'),
    renderCloudflareStaticEntry({
      runtimeImport: 'void/edge',
      headerRules: [],
      redirectRules: [],
      fallbackRules: [],
    }),
  );
  const configPath = join(generated, 'wrangler-static.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      name: 'void-static-test',
      account_id: 'account-id',
      compatibility_date: '2026-09-29',
      main: 'static-edge.mjs',
      workers_dev: true,
      assets: {
        binding: 'ASSETS',
        directory: './assets',
        run_worker_first: true,
        not_found_handling: 'single-page-application',
      },
    }),
  );
  const prepared = await prepareCfStaticBuildOutput({
    projectRoot: root,
    configPath,
    assetsDirectory: assets,
    accountId: 'account-id',
  });
  expect(prepared).not.toBeNull();
  if (!prepared) {
    return;
  }
  try {
    const built = await readBuildOutput(prepared.directory);
    expect(built.workers.default.config.manifest?.mainModule).toBe('index.js');
    expect(built.workers.default.assetsDir).toBeDefined();
    expect(prepared.assetsDirectory).toBe(assets);
    const cf = join(dirname(fileURLToPath(import.meta.resolve('cf/package.json'))), 'bin', 'cf');
    const dryRun = spawnSync(process.execPath, [cf, 'deploy', '--prebuilt', '--dry-run'], {
      cwd: prepared.directory,
      encoding: 'utf8',
    });
    expect(dryRun.status, `${dryRun.stdout}\n${dryRun.stderr}`).toBe(0);
  } finally {
    prepared.dispose();
  }
});
