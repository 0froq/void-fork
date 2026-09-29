import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import {
  getWorkerBundleDir,
  readBuildOutput,
  writeAssets,
  writeRootConfig,
  writeWorkerConfig,
} from '@cloudflare/build-output-utils';
import { InputConfigSchema, convertToWranglerConfig } from '@cloudflare/config';
import { basename, dirname, extname, join, relative, resolve } from 'pathslash';
import { build } from 'vite';

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

function entries(value: unknown): Array<JsonObject> | null {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) && value.every((entry) => object(entry) !== null)
    ? (value as Array<JsonObject>)
    : null;
}

function empty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.length === 0) ||
    (object(value) !== null && Object.keys(value as JsonObject).length === 0)
  );
}

function defaultModuleRules(value: unknown): boolean {
  if (empty(value)) {
    return true;
  }
  return isDeepStrictEqual(value, [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }]);
}

/**
 * The Vite plugin still builds Void's Worker. This bridge only accepts the
 * Wrangler output fields that cf can represent exactly; every other case
 * stays on the existing uploader until the new format covers it.
 */
function toCfWorker(raw: JsonObject): ReturnType<typeof InputConfigSchema.parse> | null {
  if (typeof raw.name !== 'string' || typeof raw.compatibility_date !== 'string') {
    return null;
  }
  if (!defaultModuleRules(raw.rules)) {
    return null;
  }
  if (!empty(raw.logfwdr) && !isDeepStrictEqual(raw.logfwdr, { bindings: [] })) {
    return null;
  }

  const ignored = new Set([
    'configPath',
    'userConfigPath',
    'topLevelName',
    'definedEnvironments',
    'account_id',
    'main',
    'jsx_factory',
    'jsx_fragment',
    'rules',
    'python_modules',
    'dev',
    'no_bundle',
    'compatibility_date',
    'compatibility_flags',
    'name',
    'assets',
    'vars',
    'kv_namespaces',
    'd1_databases',
    'r2_buckets',
    'triggers',
    'workers_dev',
    'preview_urls',
    'durable_objects',
    'queues',
    'logfwdr',
  ]);
  for (const [key, value] of Object.entries(raw)) {
    if (!ignored.has(key) && !empty(value)) {
      return null;
    }
  }

  const env: JsonObject = {};
  const vars = object(raw.vars);
  if (raw.vars !== undefined && vars === null) {
    return null;
  }
  for (const [binding, value] of Object.entries(vars ?? {})) {
    if (binding in env) {
      return null;
    }
    env[binding] = typeof value === 'string' ? { type: 'text', value } : { type: 'json', value };
  }

  const kv = entries(raw.kv_namespaces);
  const d1 = entries(raw.d1_databases);
  const r2 = entries(raw.r2_buckets);
  if (kv === null || d1 === null || r2 === null) {
    return null;
  }
  for (const entry of kv) {
    if (typeof entry.binding !== 'string' || typeof entry.id !== 'string') {
      return null;
    }
    if (entry.binding in env) {
      return null;
    }
    env[entry.binding] = { type: 'kv', id: entry.id };
  }
  for (const entry of d1) {
    if (typeof entry.binding !== 'string' || typeof entry.database_id !== 'string') {
      return null;
    }
    if (entry.binding in env) {
      return null;
    }
    env[entry.binding] = {
      type: 'd1',
      id: entry.database_id,
      ...(typeof entry.database_name === 'string' ? { name: entry.database_name } : {}),
    };
  }
  for (const entry of r2) {
    if (typeof entry.binding !== 'string' || typeof entry.bucket_name !== 'string') {
      return null;
    }
    if (entry.binding in env) {
      return null;
    }
    env[entry.binding] = {
      type: 'r2',
      name: entry.bucket_name,
      ...(typeof entry.jurisdiction === 'string' ? { jurisdiction: entry.jurisdiction } : {}),
    };
  }

  const assets = object(raw.assets);
  if (raw.assets !== undefined && assets === null) {
    return null;
  }
  if (assets?.binding !== undefined) {
    if (typeof assets.binding !== 'string') {
      return null;
    }
    if (assets.binding in env) {
      return null;
    }
    env[assets.binding] = { type: 'assets' };
  }
  const assetConfig = assets
    ? {
        ...(typeof assets.html_handling === 'string' ? { htmlHandling: assets.html_handling } : {}),
        ...(typeof assets.not_found_handling === 'string'
          ? { notFoundHandling: assets.not_found_handling }
          : {}),
        ...(assets.run_worker_first !== undefined
          ? { runWorkerFirst: assets.run_worker_first }
          : {}),
      }
    : undefined;

  const triggers = object(raw.triggers);
  if (raw.triggers !== undefined && triggers === null) {
    return null;
  }
  if (triggers && Object.keys(triggers).some((key) => key !== 'crons')) {
    return null;
  }
  const crons = triggers?.crons;
  if (
    crons !== undefined &&
    (!Array.isArray(crons) || !crons.every((cron) => typeof cron === 'string'))
  ) {
    return null;
  }
  if (!empty(raw.durable_objects) && !isDeepStrictEqual(raw.durable_objects, { bindings: [] })) {
    return null;
  }
  if (!empty(raw.queues) && !isDeepStrictEqual(raw.queues, { producers: [], consumers: [] })) {
    return null;
  }

  const result = InputConfigSchema.safeParse({
    worker: {
      name: raw.name,
      compatibilityDate: raw.compatibility_date,
      ...(Array.isArray(raw.compatibility_flags)
        ? { compatibilityFlags: raw.compatibility_flags }
        : {}),
      ...(assetConfig ? { assets: assetConfig } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(Array.isArray(crons)
        ? { triggers: crons.map((schedule) => ({ type: 'scheduled', schedule })) }
        : {}),
      ...(typeof raw.workers_dev === 'boolean' ? { workersDev: raw.workers_dev } : {}),
      ...(typeof raw.preview_urls === 'boolean' ? { previewUrls: raw.preview_urls } : {}),
    },
  });
  if (!result.success) {
    return null;
  }

  const roundTrip = convertToWranglerConfig(result.data) as JsonObject;
  for (const field of [
    'name',
    'compatibility_date',
    'compatibility_flags',
    'assets',
    'vars',
    'kv_namespaces',
    'd1_databases',
    'r2_buckets',
    'triggers',
    'workers_dev',
    'preview_urls',
  ]) {
    const original =
      field === 'assets' && assets
        ? Object.fromEntries(Object.entries(assets).filter(([key]) => key !== 'directory'))
        : raw[field];
    if (
      !isDeepStrictEqual(
        empty(original) ? undefined : original,
        empty(roundTrip[field]) ? undefined : roundTrip[field],
      )
    ) {
      return null;
    }
  }
  return result.data;
}

function copyBundle(source: string, destination: string): boolean {
  for (const entry of readdirSync(source, { recursive: true, withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      return false;
    }
    if (!entry.isFile()) {
      continue;
    }
    const absolute = join(entry.parentPath, entry.name);
    const name = relative(source, absolute);
    if (name === 'wrangler.json' || name === join('.vite', 'manifest.json')) {
      continue;
    }
    const extension = extname(entry.name);
    if (!['.js', '.mjs', '.map'].includes(extension)) {
      return false;
    }
    const destinationPath = join(destination, name);
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(absolute, destinationPath);
  }
  return true;
}

/** Create a private cf Build Output tree from Void's verified Vite artifact. */
export async function prepareCfBuildOutput(
  workerDirectory: string,
  accountId: string,
): Promise<CfBuildOutput | null> {
  const source = resolve(workerDirectory);
  const raw = object(JSON.parse(readFileSync(join(source, 'wrangler.json'), 'utf8')));
  if (!raw) {
    return null;
  }
  if (typeof raw.account_id === 'string' && raw.account_id !== accountId) {
    return null;
  }
  const config = toCfWorker(raw);
  if (!config?.worker) {
    return null;
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
    if (!copyBundle(source, bundle)) {
      rmSync(directory, { recursive: true, force: true });
      return null;
    }
    await writeRootConfig(directory, { accountId }, { isPreview: false, mode: 'production' });
    await writeWorkerConfig({
      root: directory,
      config: config.worker,
      manifest: { type: 'partial', mainModule: main, modules: {} },
    });
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
    return await prepareCfBuildOutput(scratch, options.accountId);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
