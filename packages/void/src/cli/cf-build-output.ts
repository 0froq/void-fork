import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  getWorkerBundleDir,
  normalizeDirectoryName,
  readBuildOutput,
  writeAssets,
  writeContainerConfig,
  writeRootConfig,
  writeWorkerConfig,
} from '@cloudflare/build-output-utils';
import { type ModuleType, OutputContainerSchema } from '@cloudflare/config';
import { basename, dirname, extname, join, relative, resolve } from 'pathslash';
import { build } from 'vite';
import { migrateBuiltWranglerConfig } from './cf-config-migrate.ts';

type JsonObject = Record<string, unknown>;

export interface CfBuildOutput {
  directory: string;
  assetsDirectory?: string;
  dispose(): void;
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

// Match the additional modules emitted by the Cloudflare Vite plugin. A complete
// manifest keeps cf from treating text, binary, and Wasm imports as JavaScript.
const moduleTypes: Record<string, ModuleType> = {
  '.js': 'esm',
  '.mjs': 'esm',
  '.cjs': 'cjs',
  '.wasm': 'wasm',
  '.bin': 'data',
  '.txt': 'text',
  '.html': 'text',
  '.sql': 'text',
  '.json': 'json',
  '.map': 'sourcemap',
};

function copyBundle(
  source: string,
  destination: string,
): Record<string, { type: ModuleType }> | null {
  const modules: Record<string, { type: ModuleType }> = {};
  for (const entry of readdirSync(source, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }
    const absolute = join(entry.parentPath, entry.name);
    if (entry.isSymbolicLink()) {
      const target = realpathSync(absolute);
      if (!target.startsWith(`${realpathSync(source)}/`)) {
        throw new Error('The built Worker contains a symlink outside its output directory.');
      }
    }
    const name = relative(source, absolute);
    if (
      name === 'wrangler.json' ||
      name === '.dev.vars' ||
      name === join('.vite', 'manifest.json')
    ) {
      continue;
    }
    const type = moduleTypes[extname(entry.name).toLowerCase()];
    if (!type) {
      return null;
    }
    const destinationPath = join(destination, name);
    mkdirSync(dirname(destinationPath), { recursive: true });
    if (entry.isSymbolicLink()) {
      copyFileSync(realpathSync(absolute), destinationPath);
    } else {
      cpSync(absolute, destinationPath);
    }
    modules[name] = { type };
  }
  return modules;
}

/** Create a private cf Build Output tree from Void's verified Vite artifact. */
export async function prepareCfBuildOutput(
  workerDirectory: string,
  accountId: string,
  options: { inheritedBindings?: ReadonlyArray<Record<string, unknown>> } = {},
): Promise<CfBuildOutput | null> {
  const source = resolve(workerDirectory);
  const raw = object(JSON.parse(readFileSync(join(source, 'wrangler.json'), 'utf8')));
  if (!raw) {
    return null;
  }
  if (typeof raw.account_id === 'string' && raw.account_id !== accountId) {
    return null;
  }
  const config = migrateBuiltWranglerConfig(raw, options);
  if (!config.worker) {
    throw new Error('cf did not produce a Worker configuration.');
  }
  const main = raw.main;
  if (typeof main !== 'string' || basename(main) !== main || !existsSync(join(source, main))) {
    return null;
  }

  const assets = object(raw.assets);
  const assetsDirectory = assets?.directory;
  if (assetsDirectory !== undefined && typeof assetsDirectory !== 'string') {
    return null;
  }
  const directory = mkdtempSync(join(tmpdir(), 'void-cf-deploy-'));
  try {
    const bundle = getWorkerBundleDir(directory);
    mkdirSync(bundle, { recursive: true });
    const modules = copyBundle(source, bundle);
    if (!modules) {
      rmSync(directory, { recursive: true, force: true });
      return null;
    }
    await writeRootConfig(directory, { accountId }, { isPreview: false, mode: 'production' });
    await writeWorkerConfig({
      root: directory,
      config: config.worker,
      manifest: { type: 'complete', mainModule: main, modules },
    });
    for (const container of config.containers ?? []) {
      await writeContainerConfig({
        root: directory,
        config: OutputContainerSchema.parse(container),
        directoryName: normalizeDirectoryName(container.name),
      });
    }
    if (typeof assetsDirectory === 'string') {
      const assetPath = resolve(source, assetsDirectory);
      if (!existsSync(assetPath)) {
        rmSync(directory, { recursive: true, force: true });
        return null;
      }
      await writeAssets({ root: directory, sourceDirectory: assetPath });
    }
    await readBuildOutput(directory);
    return {
      directory,
      ...(typeof assetsDirectory === 'string'
        ? { assetsDirectory: resolve(source, assetsDirectory) }
        : {}),
      dispose: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Bundle Void's generated thin static Worker before handing it to cf as prebuilt output. */
export async function prepareCfStaticBuildOutput(options: {
  projectRoot: string;
  configPath: string;
  assetsDirectory: string;
  accountId: string;
  inheritedBindings?: ReadonlyArray<Record<string, unknown>>;
}): Promise<CfBuildOutput | null> {
  const raw = object(JSON.parse(readFileSync(options.configPath, 'utf8')));
  if (!raw || typeof raw.main !== 'string' || basename(raw.main) !== raw.main) {
    return null;
  }
  const entry = join(dirname(options.configPath), raw.main);
  if (!existsSync(entry)) {
    return null;
  }
  const scratch = mkdtempSync(join(tmpdir(), 'void-cf-static-'));
  try {
    await build({
      configFile: false,
      root: options.projectRoot,
      publicDir: false,
      logLevel: 'error',
      build: {
        outDir: scratch,
        emptyOutDir: true,
        lib: { entry, formats: ['es'], fileName: 'index' },
        target: 'es2022',
      },
    });
    writeFileSync(
      join(scratch, 'wrangler.json'),
      JSON.stringify({
        ...raw,
        main: 'index.js',
        assets: { ...object(raw.assets), directory: resolve(options.assetsDirectory) },
      }),
      { mode: 0o600 },
    );
    return await prepareCfBuildOutput(scratch, options.accountId, {
      inheritedBindings: options.inheritedBindings,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
