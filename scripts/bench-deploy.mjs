// Local-only investigation harness. No account operations or real deployments.
// Run with the repository's Node version and --experimental-transform-types.
// --builds adds three builds of each isolated playground copy.
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { cpus, platform, arch, tmpdir } from 'node:os';
// This standalone harness uses native paths for subprocesses and filesystem snapshots.
// oxlint-disable-next-line no-restricted-imports
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
const filter = process.argv.find((arg) => arg.startsWith('--filter='))?.slice('--filter='.length);
const selected = (name) => filter === undefined || name.includes(filter);
const activationSource = process.argv
  .find((arg) => arg.startsWith('--activation-source='))
  ?.slice('--activation-source='.length);
mkdirSync(join(root, 'playground-local'), { recursive: true });
const scratch = mkdtempSync(join(root, 'playground-local/deploy-bench-'));
const isolatedHome = join(scratch, 'home');
mkdirSync(isolatedHome);
const env = {
  PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
  HOME: isolatedHome,
  TMPDIR: tmpdir(),
  CI: 'true',
  NODE_ENV: 'production',
  WRANGLER_SEND_METRICS: 'false',
  VOID_CLOUDFLARE_DEPLOY_BUILD: '1',
  VOID_REMOTE: '0',
};
const report = {
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  node: process.version,
  platform: `${platform()}-${arch()}`,
  cpu: cpus()[0]?.model,
  date: new Date().toISOString(),
  notes: [
    'Local timings only; no provider calls.',
    'Filesystem cache not flushed.',
    'Samples are sequential; fixtures share installed workspace dependencies.',
  ],
  measurements: [],
};
async function measure(name, repetitions, fn) {
  if (!selected(name)) {
    return;
  }
  const samplesMs = [];
  let detail;
  for (let i = 0; i < repetitions; i++) {
    const start = performance.now();
    detail = await fn();
    samplesMs.push(Number((performance.now() - start).toFixed(3)));
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const entry = { name, samplesMs, medianMs: sorted[Math.floor(sorted.length / 2)], detail };
  report.measurements.push(entry);
  process.stderr.write(`${name}: ${entry.medianMs} ms\n`);
  return entry;
}
function child(args, cwd = scratch, extra = {}, executable = process.execPath) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    ...extra,
  });
  if (result.status !== 0) {
    throw new Error(`${basename(args[0])}: ${result.error ?? result.stderr ?? result.signal}`);
  }
  return result;
}
function cloneFixture(name) {
  const source = join(root, 'playground', name);
  const dest = join(scratch, name);
  cpSync(source, dest, {
    recursive: true,
    filter(path) {
      return !relative(source, path)
        .split('/')
        .some(
          (part) =>
            ['node_modules', 'dist', '.void', '.wrangler', '.git'].includes(part) ||
            part.startsWith('.env'),
        );
    },
  });
  symlinkSync(join(source, 'node_modules'), join(dest, 'node_modules'), 'dir');
  return dest;
}
function treeStats(directory) {
  let bytes = 0;
  let files = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const sub = treeStats(path);
      bytes += sub.bytes;
      files += sub.files;
    } else {
      bytes += statSync(path).size;
      files++;
    }
  }
  return { bytes, files };
}
try {
  const deploy = await import(join(root, 'packages/void/src/cli/deploy.ts'));
  const { resolveWranglerArgv } = await import(join(root, 'packages/void/src/cli/preset.ts'));
  const { collectAndHashAssets } = await import(join(root, 'packages/void/src/cli/package.ts'));
  const { inferProjectBindings } = await import(
    join(root, 'packages/void/src/plugin-inference.ts')
  );
  const { scanRoutes } = await import(join(root, 'packages/void/src/router/scan.ts'));
  const { stageCloudflareStaticAssets } = await import(
    join(root, 'packages/deploy-cloudflare/src/static.ts')
  );
  const { activateCloudflareVersion, encodeCloudflareVersionMessage, readCloudflareTriggerConfig } =
    await import(
      pathToFileURL(join(root, activationSource ?? 'packages/deploy-cloudflare/src/version.ts'))
        .href
    );
  const wrangler = resolveWranglerArgv(root).at(-1);
  const dist = join(root, 'packages/void/dist');
  const deployChunk = readdirSync(dist).find((file) => /^deploy-[\w-]+\.mjs$/.test(file));
  await measure('node-empty-process', 9, () => {
    child(['-e', '']);
  });
  await measure('packaged-cli-deploy-help', 9, () => {
    child([join(dist, 'cli/cli.mjs'), 'deploy', '--help']);
  });
  await measure('packaged-deploy-import-process', 9, () => {
    child([
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(pathToFileURL(join(dist, deployChunk)).href)})`,
    ]);
  });
  for (const args of [
    ['deployments', 'status'],
    ['versions', 'upload'],
    ['triggers', 'deploy'],
  ]) {
    await measure(`wrangler-${args.join('-')}-help-process`, 9, () => {
      child([wrangler, ...args, '--help']);
    });
  }
  const uploaderStats = treeStats(dirname(wrangler));
  await measure('uploader-content-hash', 20, () => {
    if (!deploy.hashWranglerUploader(root)) {
      throw new Error('hash failed');
    }
    return uploaderStats;
  });
  const probe = join(dist, 'cli/env-schema-probe.mjs');
  await measure('schema-facts-absent-subprocess', 7, () => {
    const result = child(
      [probe, '__void-deploy-env-schema-probe__', JSON.stringify({ op: 'facts', root: scratch })],
      scratch,
      { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] },
    );
    if (JSON.parse(result.output[3]).kind !== 'ok') {
      throw new Error('probe failed');
    }
  });
  for (const [count, size] of [
    [1000, 4096],
    [5000, 4096],
    [1000, 131072],
  ]) {
    if (!selected(`hash-${count}x${size}`) && !selected(`static-stage-${count}x${size}`)) {
      continue;
    }
    const directory = join(scratch, `assets-${count}-${size}`);
    mkdirSync(directory);
    for (let i = 0; i < count; i++) {
      const data = Buffer.alloc(size, 97);
      data.writeUInt32LE(i, 0);
      writeFileSync(join(directory, `${i}.js`), data);
    }
    await measure(`hash-${count}x${size}`, 5, async () => {
      const result = await collectAndHashAssets(directory, () => {});
      return { assets: result.assetFiles.size, totalBytes: count * size };
    });
    await measure(`static-stage-${count}x${size}`, 3, () => {
      stageCloudflareStaticAssets({
        sourceDirectory: directory,
        destinationDirectory: join(scratch, 'staged'),
      });
    });
  }
  const kitchen =
    ['infer-kitchen-sink', 'scan-kitchen-sink', 'drift-kitchen-sink'].some(selected) ||
    process.argv.includes('--builds')
      ? cloneFixture('kitchen-sink')
      : undefined;
  await measure('infer-kitchen-sink', 10, () => {
    inferProjectBindings(kitchen);
  });
  await measure('scan-kitchen-sink', 10, async () => {
    await scanRoutes(kitchen, { environment: 'prod' });
  });
  await measure('drift-kitchen-sink', 5, () => ({
    drift: deploy.hasDeploySchemaDrift(kitchen, 'sqlite'),
  }));

  // Trace the actual activator with a deterministic local fake transport.
  const configPath = join(scratch, 'wrangler.json');
  writeFileSync(
    configPath,
    JSON.stringify({ name: 'bench', workers_dev: true, preview_urls: true }),
  );
  const message = encodeCloudflareVersionMessage([], readCloudflareTriggerConfig(configPath));
  const previous = '11111111-1111-4111-8111-111111111111';
  const next = '22222222-2222-4222-8222-222222222222';
  let active = previous;
  let uploaded = false;
  let integrityChecks = 0;
  const commands = [];
  const activationStarted = performance.now();
  const activation = await activateCloudflareVersion({
    workerName: 'bench',
    configPath,
    message,
    verifyInheritedSecrets: true,
    verifyUploader: () => {
      integrityChecks++;
      return true;
    },
    fetch: async () => Response.json({ ready: true }),
    runWrangler: async (args) => {
      const key = args.slice(0, 2).join(' ');
      commands.push(key);
      if (process.argv.includes('--activation-cli-startup')) {
        // Measure real CLI startup without invoking an authenticated command.
        child([wrangler, ...args.slice(0, 2), '--help']);
      }
      const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
      if (key === 'deployments status') {
        return ok(JSON.stringify({ versions: [{ version_id: active, percentage: 100 }] }));
      }
      if (key === 'versions list') {
        return ok(
          JSON.stringify([
            { id: previous, number: 1, annotations: { 'workers/message': message } },
            ...(uploaded
              ? [{ id: next, number: 2, annotations: { 'workers/message': message } }]
              : []),
          ]),
        );
      }
      if (key === 'versions upload') {
        uploaded = true;
        return ok(
          `Worker Version ID: ${next}\nVersion Preview Alias URL: https://ready.bench.workers.dev`,
        );
      }
      if (key === 'versions deploy') {
        active = next;
        return ok();
      }
      if (key === 'triggers deploy') {
        return ok();
      }
      throw new Error(`Unexpected command ${key}`);
    },
  });
  if (!activation.ok) {
    throw new Error(`Activation trace failed: ${JSON.stringify(activation)}`);
  }
  report.activationTrace = {
    commands,
    integrityChecks,
    durationMs: performance.now() - activationStarted,
    cliStartupMeasured: process.argv.includes('--activation-cli-startup'),
    note: 'No provider calls. Optional CLI startup timing runs help commands only.',
  };

  if (process.argv.includes('--builds')) {
    for (const name of ['spa', 'react-pages', 'static-pages', 'kitchen-sink']) {
      const fixture = name === 'kitchen-sink' ? kitchen : cloneFixture(name);
      const vp = join(root, 'node_modules/.bin', process.platform === 'win32' ? 'vp.cmd' : 'vp');
      const artifactDigests = [];
      await measure(`build-${name}`, 3, () => {
        const result = child(['build'], fixture, {}, vp);
        const worker = join(fixture, 'dist/ssr/index.js');
        if (existsSync(worker)) {
          artifactDigests.push(createHash('sha256').update(readFileSync(worker)).digest('hex'));
        }
        const builtLines = result.stdout
          .split('\n')
          .filter((line) => /built in|prerender/.test(line));
        return { output: builtLines, workerDigestsAcrossRuns: artifactDigests };
      });
    }
  }
  const json = JSON.stringify(report, null, 2) + '\n';
  if (outputArg) {
    writeFileSync(outputArg.slice('--output='.length), json);
  } else {
    process.stdout.write(json);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
