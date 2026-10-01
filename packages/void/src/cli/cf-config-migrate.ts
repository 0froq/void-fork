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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { InputConfigSchema } from '@cloudflare/config';
import { dirname, join } from 'pathslash';

type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function empty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.length === 0) ||
    (record(value) !== null && Object.keys(value as JsonObject).length === 0)
  );
}

/** Remove build-only fields and settings translated into cf's typed config below. */
function migrationInput(raw: JsonObject): JsonObject {
  const result = { ...raw };
  if (
    !empty(result.rules) &&
    !isDeepStrictEqual(result.rules, [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }])
  ) {
    throw new Error('cf cannot yet preserve custom Worker module rules in a prebuilt bundle.');
  }
  if (empty(result.logfwdr) || isDeepStrictEqual(result.logfwdr, { bindings: [] })) {
    delete result.logfwdr;
  }
  for (const key of [
    'configPath',
    'userConfigPath',
    'topLevelName',
    'main',
    'jsx_factory',
    'jsx_fragment',
    'rules',
    'python_modules',
    'dev',
    'no_bundle',
    'build',
    'keep_vars',
    'keep_secrets',
    'keep_assets',
    'send_metrics',
    'workflows',
  ]) {
    delete result[key];
  }
  for (const [key, value] of Object.entries(result)) {
    if (empty(value)) {
      delete result[key];
    }
  }
  return result;
}

function applyPreservationFlags(raw: JsonObject, worker: JsonObject): void {
  // cf forwards unsafe.metadata to the Worker upload metadata, including these API flags.
  const keepBindings = [
    ...(raw.keep_vars === true ? ['plain_text', 'json'] : []),
    ...(raw.keep_secrets === true ? ['secret_text', 'secret_key'] : []),
  ];
  if (keepBindings.length === 0 && raw.keep_assets !== true) {
    return;
  }
  const unsafe = record(worker.unsafe) ?? {};
  const metadata = record(unsafe.metadata) ?? {};
  const previous = metadata.keep_bindings;
  if (
    previous !== undefined &&
    (!Array.isArray(previous) || !previous.every((value) => typeof value === 'string'))
  ) {
    throw new Error('Invalid keep_bindings in the built Cloudflare config.');
  }
  worker.unsafe = {
    ...unsafe,
    metadata: {
      ...metadata,
      ...(keepBindings.length > 0
        ? { keep_bindings: [...new Set([...(previous ?? []), ...keepBindings])] }
        : {}),
      ...(raw.keep_assets === true ? { keep_assets: true } : {}),
    },
  };
}

function applyWorkflows(raw: JsonObject, worker: JsonObject): void {
  if (raw.workflows === undefined || empty(raw.workflows)) {
    return;
  }
  if (!Array.isArray(raw.workflows)) {
    throw new Error('Invalid Workflow bindings in the built Cloudflare config.');
  }
  const env = record(worker.env) ?? {};
  const exports = record(worker.exports) ?? {};
  for (const item of raw.workflows) {
    const workflow = record(item);
    if (
      !workflow ||
      typeof workflow.binding !== 'string' ||
      typeof workflow.name !== 'string' ||
      typeof workflow.class_name !== 'string' ||
      (workflow.script_name !== undefined && typeof workflow.script_name !== 'string')
    ) {
      throw new Error('Invalid Workflow binding in the built Cloudflare config.');
    }
    const allowed = new Set([
      'binding',
      'name',
      'class_name',
      'script_name',
      'limits',
      'concurrency',
      'schedules',
      'default_retention',
    ]);
    for (const key of Object.keys(workflow)) {
      if (!allowed.has(key)) {
        throw new Error(`cf cannot migrate Workflow setting ${key}.`);
      }
    }
    if (Object.hasOwn(env, workflow.binding)) {
      throw new Error(`Duplicate Worker binding ${workflow.binding}.`);
    }
    env[workflow.binding] = {
      type: 'workflow',
      name: workflow.name,
      worker: workflow.script_name ?? worker.name,
      exportName: workflow.class_name,
    };
    if (workflow.script_name !== undefined && workflow.script_name !== worker.name) {
      continue;
    }
    const retention = record(workflow.default_retention);
    if (Object.hasOwn(exports, workflow.class_name)) {
      throw new Error(`Duplicate Worker export ${workflow.class_name}.`);
    }
    const schedules =
      Array.isArray(workflow.schedules) && workflow.schedules.length === 0
        ? undefined
        : workflow.schedules;
    exports[workflow.class_name] = {
      type: 'workflow',
      name: workflow.name,
      ...(workflow.limits !== undefined ? { limits: workflow.limits } : {}),
      ...(workflow.concurrency !== undefined ? { concurrency: workflow.concurrency } : {}),
      ...(schedules !== undefined ? { schedules } : {}),
      ...(retention
        ? {
            defaultRetention: {
              ...(retention.success_retention !== undefined
                ? { successRetention: retention.success_retention }
                : {}),
              ...(retention.error_retention !== undefined
                ? { errorRetention: retention.error_retention }
                : {}),
            },
          }
        : {}),
    };
  }
  worker.env = env;
  worker.exports = exports;
}

function uncredentialedEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:CLOUDFLARE|CF_|WRANGLER|VOID_PLATFORM_|DATABASE_URL|VOID_ACCESS_)/i.test(key)) {
      delete env[key];
    }
  }
  env.CF_DELEGATION = '1';
  return env;
}

function migrationFollowUps(output: string): Array<{ path: string; message: string }> {
  return [...output.matchAll(/\[required\] ([^:\n]+): ([^\n]+)/g)].map((match) => ({
    path: match[1]!,
    message: match[2]!,
  }));
}

function assertHandledFollowUps(output: string): void {
  for (const item of migrationFollowUps(output)) {
    const handled =
      (item.path === 'assets.directory' && item.message.includes('assets directory')) ||
      (/^d1_databases\.\d+$/.test(item.path) && /`migrations_(?:dir|table)`/.test(item.message)) ||
      /^durable_objects\.bindings\.\d+$/.test(item.path) ||
      item.path === 'migrations' ||
      item.path === 'containers';
    if (!handled) {
      throw new Error(`cf cannot migrate Cloudflare setting ${item.path}: ${item.message}`);
    }
  }
}

function durableObjectExports(raw: JsonObject): JsonObject {
  const migrations = raw.migrations;
  if (migrations === undefined || (Array.isArray(migrations) && migrations.length === 0)) {
    return {};
  }
  if (!Array.isArray(migrations) || !migrations.every((entry) => record(entry))) {
    throw new Error('Invalid Durable Object migrations in the built Cloudflare config.');
  }
  const exports: JsonObject = {};
  for (const migration of migrations as Array<JsonObject>) {
    const known = new Set([
      'tag',
      'new_classes',
      'new_sqlite_classes',
      'renamed_classes',
      'deleted_classes',
    ]);
    for (const key of Object.keys(migration)) {
      if (!known.has(key)) {
        throw new Error(`cf cannot migrate Durable Object migration setting ${key}.`);
      }
    }
    for (const [field, storage] of [
      ['new_classes', 'legacy-kv'],
      ['new_sqlite_classes', 'sqlite'],
    ] as const) {
      const classes = migration[field] ?? [];
      if (!Array.isArray(classes) || !classes.every((name) => typeof name === 'string')) {
        throw new Error(`Invalid ${field} in the built Cloudflare config.`);
      }
      for (const name of classes) {
        exports[name] = { type: 'durable-object', storage };
      }
    }
    const renamed = migration.renamed_classes ?? [];
    if (!Array.isArray(renamed) || !renamed.every((entry) => record(entry))) {
      throw new Error('Invalid renamed_classes in the built Cloudflare config.');
    }
    for (const item of renamed as Array<JsonObject>) {
      if (typeof item.from !== 'string' || typeof item.to !== 'string') {
        throw new Error('Invalid Durable Object class rename in the built Cloudflare config.');
      }
      const old = record(exports[item.from]);
      if (!old || (old.storage !== 'sqlite' && old.storage !== 'legacy-kv')) {
        throw new Error(`Cannot determine the storage of renamed Durable Object ${item.from}.`);
      }
      exports[item.from] = { type: 'durable-object', state: 'renamed', renamedTo: item.to };
      exports[item.to] = { type: 'durable-object', storage: old.storage };
    }
    const deleted = migration.deleted_classes ?? [];
    if (!Array.isArray(deleted) || !deleted.every((name) => typeof name === 'string')) {
      throw new Error('Invalid deleted_classes in the built Cloudflare config.');
    }
    for (const name of deleted) {
      exports[name] = { type: 'durable-object', state: 'deleted' };
    }
  }
  return exports;
}

function containersFromWrangler(raw: JsonObject, exports: JsonObject): Array<JsonObject> {
  const values = raw.containers;
  if (values === undefined) {
    return [];
  }
  if (!Array.isArray(values) || !values.every((value) => record(value))) {
    throw new Error('Invalid Containers in the built Cloudflare config.');
  }
  return (values as Array<JsonObject>).map((value) => {
    if (typeof value.name !== 'string' || typeof value.class_name !== 'string') {
      throw new Error('cf requires a name and class_name for each Container.');
    }
    const managed = value.scheduling_policy === 'durable_object';
    const fields = new Set(
      managed
        ? ['name', 'class_name', 'scheduling_policy', 'images']
        : ['name', 'class_name', 'image', 'max_instances', 'instance_type'],
    );
    for (const key of Object.keys(value)) {
      if (!fields.has(key)) {
        throw new Error(`cf cannot migrate Container setting ${key}.`);
      }
    }
    const declaration = record(exports[value.class_name]);
    if (!declaration || declaration.storage !== 'sqlite') {
      throw new Error(`Container ${value.name} needs a SQLite Durable Object export.`);
    }
    declaration.container = value.name;
    if (managed) {
      const images = record(value.images);
      if (!images) {
        throw new Error('A Sandbox requires a named image.');
      }
      return {
        name: value.name,
        schedulingPolicy: 'durable-object',
        images: Object.fromEntries(
          Object.entries(images).map(([name, image]) => {
            const source = record(image);
            if (
              !source ||
              Object.keys(source).some(
                (key) => !['dockerfile', 'build_context', 'image'].includes(key),
              ) ||
              (source.dockerfile !== undefined && source.image !== undefined) ||
              (source.build_context !== undefined && typeof source.build_context !== 'string')
            ) {
              throw new Error('Invalid Sandbox image.');
            }
            if (typeof source.dockerfile === 'string') {
              return [
                name,
                {
                  dockerfile: source.dockerfile,
                  ...(typeof source.build_context === 'string'
                    ? { buildContext: source.build_context }
                    : {}),
                },
              ];
            }
            if (typeof source.image === 'string') {
              return [name, { reference: source.image }];
            }
            throw new Error('Invalid Sandbox image source.');
          }),
        ),
      };
    }
    if (typeof value.image !== 'string') {
      throw new Error('A Container requires an image.');
    }
    return {
      name: value.name,
      image: { reference: value.image },
      ...(typeof value.max_instances === 'number' ? { maxInstances: value.max_instances } : {}),
      ...(typeof value.instance_type === 'string' ? { instanceType: value.instance_type } : {}),
    };
  });
}

/**
 * Ask the pinned cf CLI to translate the Vite plugin's generated JSON config.
 * Migration runs on a disposable copy without Cloudflare credentials; its
 * generated module is evaluated in a second uncredentialed Node process.
 */
export function migrateBuiltWranglerConfig(
  raw: JsonObject,
): ReturnType<typeof InputConfigSchema.parse> {
  const cfPackage = fileURLToPath(import.meta.resolve('cf/package.json'));
  const cfBinary = join(dirname(cfPackage), 'bin', 'cf');
  const directory = mkdtempSync(join(tmpdir(), 'void-cf-config-'));
  try {
    mkdirSync(join(directory, 'node_modules'));
    symlinkSync(dirname(cfPackage), join(directory, 'node_modules', 'cf'), 'junction');
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        name: 'void-private-cf-build',
        private: true,
        type: 'module',
        dependencies: { cf: '1.0.0', '@cloudflare/vite-plugin': '1.0.0' },
      }),
      { mode: 0o600 },
    );
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(configPath, JSON.stringify(migrationInput(raw)), { mode: 0o600 });
    const env = uncredentialedEnvironment();
    const migrated = spawnSync(
      process.execPath,
      [cfBinary, 'migrate', configPath, '--bundler', 'vite', '--no-install', '--force'],
      { cwd: directory, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const generatedPath = join(directory, 'cloudflare.config.ts');
    if (!existsSync(generatedPath) || migrated.error) {
      throw new Error('cf could not translate the built Cloudflare configuration.');
    }
    assertHandledFollowUps(migrated.stdout);
    const generated = readFileSync(generatedPath, 'utf8');
    const executable = generated.replace(
      /^throw new Error\("Migration incomplete\.[^\n]*\);\s*$/m,
      '',
    );
    if (executable === generated && migrated.status !== 0) {
      throw new Error('cf did not provide a usable Cloudflare configuration.');
    }
    const executablePath = join(directory, 'cloudflare.config.mjs');
    writeFileSync(executablePath, executable, { mode: 0o600 });
    const evaluated = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'const mod = await import(process.argv[1]); process.stdout.write(JSON.stringify(mod.default));',
        pathToFileURL(executablePath).href,
      ],
      { cwd: directory, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
    );
    if (evaluated.status !== 0 || evaluated.error) {
      throw new Error('cf generated a configuration that Void could not validate.');
    }
    const result = record(JSON.parse(evaluated.stdout));
    const worker = record(result?.worker);
    if (!result || !worker) {
      throw new Error('cf did not generate a Worker configuration.');
    }
    applyPreservationFlags(raw, worker);
    applyWorkflows(raw, worker);
    const exports = { ...record(worker.exports), ...durableObjectExports(raw) };
    const containers = containersFromWrangler(raw, exports);
    if (containers.length > 0) {
      const envBindings = record(worker.env);
      const durableBindings = record(raw.durable_objects)?.bindings;
      if (!envBindings || !Array.isArray(durableBindings)) {
        throw new Error('A Container Durable Object binding was not found in the built config.');
      }
      for (const container of containers) {
        const className = (raw.containers as Array<JsonObject>).find(
          (entry) => entry.name === container.name,
        )?.class_name;
        const binding = durableBindings.find((entry) => record(entry)?.class_name === className);
        if (
          !record(binding) ||
          typeof binding.name !== 'string' ||
          (binding.script_name !== undefined && binding.script_name !== worker.name)
        ) {
          throw new Error(`Container ${container.name} must use a local Durable Object binding.`);
        }
        // cf's typed Durable Object binding currently serializes even a self
        // reference with script_name. Its Container uploader interprets any
        // script_name as an external Worker. The unsafe binding is the same
        // upload metadata without that external-script marker.
        envBindings[binding.name] = {
          type: 'unsafe:durable_object_namespace',
          class_name: className,
        };
      }
    }
    if (Object.keys(exports).length > 0) {
      worker.exports = exports;
    }
    if (containers.length > 0) {
      result.containers = containers;
    }
    return InputConfigSchema.parse(result);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
