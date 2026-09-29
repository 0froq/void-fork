import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getWorkerConfigPath, readBuildOutput } from '@cloudflare/build-output-utils';
import type { CloudflareCommandResult, CloudflareCommandRunner } from '@void/deploy-cloudflare';
import { dirname, join } from 'pathslash';
import type { CfBuildOutput } from './cf-build-output.ts';
import { migrateBuiltWranglerConfig } from './cf-config-migrate.ts';

type CfCommand = (
  args: Array<string>,
  options: { cwd: string; capture: boolean },
) => CloudflareCommandResult;

function failed(message: string): CloudflareCommandResult {
  return { status: 1, stdout: '', stderr: message };
}

function flag(args: ReadonlyArray<string>, name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Run the pinned package-local cf binary with Void's existing Cloudflare session. */
export function createCfCommand(options: {
  accountId: string;
  apiBaseUrl: string;
  token?: string;
  env: (accountId: string, apiBaseUrl: string) => NodeJS.ProcessEnv;
  verifyUploader: () => boolean;
}): CfCommand {
  const cf = join(dirname(fileURLToPath(import.meta.resolve('cf/package.json'))), 'bin', 'cf');
  return (args, run) => {
    if (!options.verifyUploader()) {
      return failed('The Cloudflare uploader changed during deployment.');
    }
    // Keep credentials in the verified CLI even if cwd resolves another cf.
    const env: NodeJS.ProcessEnv = {
      ...options.env(options.accountId, options.apiBaseUrl),
      CF_DELEGATION: '1',
    };
    if (options.token) {
      env.CLOUDFLARE_API_TOKEN = options.token;
    }
    const result = spawnSync(process.execPath, [cf, ...args], {
      cwd: run.cwd,
      env,
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      // Version lists contain the full Worker records. Ten sizable bundles can
      // exceed Node's 1 MiB spawnSync default before activation can inspect them.
      maxBuffer: 256 * 1024 * 1024,
      stdio: run.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    return {
      status: typeof result.status === 'number' ? result.status : 1,
      stdout: result.stdout ?? '',
      // Keep the activation protocol's provider-code parsing across CLI renderers.
      stderr: (result.stderr ?? '').replace(/\[(\d{4,})\]/g, '[code: $1]'),
      signal: result.signal ?? null,
      error: result.error?.message ?? null,
    };
  };
}

/**
 * Adapt the stable activation protocol to cf's prebuilt and API commands.
 * The protocol keeps the existing preview, inheritance, traffic and rollback checks.
 */
export function createCfVersionRunner(options: {
  output: CfBuildOutput;
  workerName: string;
  runCf: CfCommand;
}): CloudflareCommandRunner {
  const { output, workerName, runCf } = options;
  const run = (args: Array<string>, capture: boolean, cwd = output.directory) =>
    runCf(args, { cwd, capture });

  return async (args, command) => {
    if (args[0] === 'deployments' && args[1] === 'status') {
      const result = run(['workers', 'deployments', 'list', '--worker', workerName], true);
      if (result.status !== 0) {
        return result;
      }
      const body = parseJson(result.stdout);
      const deployments = record(body) ? body.deployments : undefined;
      if (Array.isArray(deployments) && deployments.length === 0) {
        return failed('The Cloudflare Worker has no deployments.');
      }
      if (!Array.isArray(deployments) || !record(deployments[0])) {
        return failed('The Cloudflare Worker deployment was not readable.');
      }
      return { ...result, stdout: JSON.stringify(deployments[0]) };
    }

    if (args[0] === 'versions' && args[1] === 'list') {
      const pageSize = 10;
      const readPage = (page: number) => {
        const result = run(
          [
            'workers',
            'versions',
            'list',
            '--worker-id',
            workerName,
            '--per-page',
            String(pageSize),
            '--page',
            String(page),
          ],
          true,
        );
        const body = parseJson(result.stdout);
        return {
          result,
          versions:
            Array.isArray(body) &&
            body.length <= pageSize &&
            body.every(
              (item) =>
                record(item) && typeof item.id === 'string' && Number.isSafeInteger(item.number),
            ) &&
            new Set(body.map((item) => item.number)).size === body.length
              ? body
              : null,
        };
      };
      const first = readPage(1);
      if (first.result.status !== 0) {
        return first.result;
      }
      if (!first.versions) {
        return failed('The Cloudflare Worker version list was not readable.');
      }
      const versions = [...first.versions];
      if (versions.length === pageSize) {
        const second = readPage(2);
        if (second.result.status !== 0 || !second.versions) {
          return failed('The Cloudflare Worker version history was not readable.');
        }
        if (second.versions.length > 0) {
          const firstNumbers = versions.map((item) => item.number as number);
          const secondNumbers = second.versions.map((item) => item.number as number);
          if (Math.min(...secondNumbers) > Math.max(...firstNumbers)) {
            versions.push(...second.versions);
            let last = Math.max(...secondNumbers);
            for (let page = 3; page <= 1000 && second.versions.length === pageSize; page++) {
              const next = readPage(page);
              if (next.result.status !== 0 || !next.versions) {
                return failed('The Cloudflare Worker version history was not readable.');
              }
              if (next.versions.length === 0) {
                break;
              }
              const numbers = next.versions.map((item) => item.number as number);
              if (Math.min(...numbers) <= last) {
                return failed('The Cloudflare Worker version history changed during inspection.');
              }
              versions.push(...next.versions);
              last = Math.max(...numbers);
              if (next.versions.length < pageSize) {
                break;
              }
              if (page === 1000) {
                return failed('The Cloudflare Worker version history is too large to verify.');
              }
            }
          } else if (Math.max(...secondNumbers) >= Math.min(...firstNumbers)) {
            return failed('The Cloudflare Worker version history changed during inspection.');
          }
        }
      }
      return {
        ...first.result,
        stdout: JSON.stringify(
          versions.sort((a, b) => (a.number as number) - (b.number as number)).slice(-10),
        ),
      };
    }

    if (args[0] === 'versions' && args[1] === 'view' && args[2]) {
      const result = run(['workers', 'versions', 'get', args[2], '--worker-id', workerName], true);
      if (result.status !== 0) {
        return result;
      }
      const version = parseJson(result.stdout);
      if (!record(version) || version.id !== args[2] || !Array.isArray(version.bindings)) {
        return failed('The Cloudflare Worker version was not readable.');
      }
      return {
        ...result,
        stdout: JSON.stringify({ ...version, resources: { bindings: version.bindings } }),
      };
    }

    if (args[0] === 'versions' && args[1] === 'upload') {
      if (
        flag(args, '--name') !== workerName ||
        (args.includes('--assets') && flag(args, '--assets') !== output.assetsDirectory)
      ) {
        return failed('The Cloudflare version upload target changed.');
      }
      return run(
        [
          'workers',
          'versions',
          'create',
          '--prebuilt',
          ...(flag(args, '--message') ? ['--message', flag(args, '--message')!] : []),
          ...(flag(args, '--secrets-file')
            ? ['--secrets-file', flag(args, '--secrets-file')!]
            : []),
          ...(flag(args, '--preview-alias')
            ? ['--preview-alias', flag(args, '--preview-alias')!]
            : []),
        ],
        command.capture,
      );
    }

    if (args[0] === 'versions' && args[1] === 'deploy') {
      if (flag(args, '--name') !== workerName) {
        return failed('The Cloudflare deployment target changed.');
      }
      const flagsStart = args.findIndex((item, index) => index >= 2 && item.startsWith('-'));
      const versions = args.slice(2, flagsStart < 0 ? undefined : flagsStart);
      if (!versions.every((item) => /^[0-9a-f-]{36}@\d+(?:\.\d+)?$/i.test(item))) {
        return failed('The Cloudflare deployment versions were invalid.');
      }
      const parsed = versions.map((item) => {
        const [version_id, percentage] = item.split('@');
        return { version_id, percentage: Number(percentage) };
      });
      if (
        parsed.length === 0 ||
        new Set(parsed.map((item) => item.version_id)).size !== parsed.length ||
        parsed.some((item) => item.percentage < 0 || item.percentage > 100) ||
        Math.abs(parsed.reduce((sum, item) => sum + item.percentage, 0) - 100) > 0.001
      ) {
        return failed('The Cloudflare deployment percentages were invalid.');
      }
      return run(
        [
          'workers',
          'deployments',
          'create',
          '--worker',
          workerName,
          '--strategy',
          'percentage',
          '--versions',
          JSON.stringify(parsed),
          ...(flag(args, '--message')
            ? [
                '--body',
                JSON.stringify({
                  strategy: 'percentage',
                  versions: parsed,
                  annotations: { 'workers/message': flag(args, '--message') },
                }),
              ]
            : []),
        ],
        command.capture,
      );
    }

    if (args[0] === 'deploy') {
      if (
        flag(args, '--name') !== workerName ||
        (args.includes('--assets') && flag(args, '--assets') !== output.assetsDirectory)
      ) {
        return failed('The Cloudflare bootstrap target changed.');
      }
      return run(
        [
          'deploy',
          '--prebuilt',
          ...(flag(args, '--message') ? ['--message', flag(args, '--message')!] : []),
          ...(flag(args, '--secrets-file')
            ? ['--secrets-file', flag(args, '--secrets-file')!]
            : []),
        ],
        command.capture,
      );
    }

    if (args[0] === 'triggers' && args[1] === 'deploy') {
      const configPath = flag(args, '-c');
      if (!configPath || flag(args, '--name') !== workerName) {
        return failed('The Cloudflare trigger target changed.');
      }
      const raw = parseJson(readFileSync(configPath, 'utf8'));
      if (!record(raw) || raw.name !== workerName) {
        return failed('The Cloudflare trigger snapshot was not readable.');
      }
      const directory = mkdtempSync(join(tmpdir(), 'void-cf-triggers-'));
      try {
        cpSync(join(output.directory, '.cloudflare'), join(directory, '.cloudflare'), {
          recursive: true,
        });
        const workerPath = getWorkerConfigPath(directory);
        const worker = parseJson(readFileSync(workerPath, 'utf8'));
        if (!record(worker)) {
          return failed('The private Cloudflare Worker config was not readable.');
        }
        const migrated = migrateBuiltWranglerConfig({
          ...raw,
          compatibility_date: worker.compatibilityDate,
        }).worker;
        if (!migrated) {
          return failed('The Cloudflare trigger snapshot was not convertible.');
        }
        const next = migrated.triggers ?? [];
        const previous = Array.isArray(worker.triggers) ? worker.triggers : [];
        const preserveRoutes = raw.routes === undefined && raw.route === undefined;
        const preserveEmail = raw.addresses === undefined;
        worker.triggers = [
          ...next,
          ...(preserveRoutes
            ? previous.filter((trigger) => record(trigger) && trigger.type === 'fetch')
            : []),
          ...(preserveEmail
            ? previous.filter((trigger) => record(trigger) && trigger.type === 'email')
            : []),
        ];
        // Workflow schedules and settings live on exports, outside `triggers`.
        // Replay the snapshot even during compensation or removal, when the
        // candidate's workflow declarations describe the version being left.
        for (const field of ['env', 'exports'] as const) {
          const previous = record(worker[field]) ? worker[field] : {};
          worker[field] = {
            ...Object.fromEntries(
              Object.entries(previous).filter(
                ([, value]) => !record(value) || value.type !== 'workflow',
              ),
            ),
            ...migrated[field],
          };
        }
        if (!preserveRoutes) {
          worker.domains = migrated.domains ?? [];
        }
        if (typeof raw.workers_dev === 'boolean') {
          worker.workersDev = raw.workers_dev;
        }
        if (typeof raw.preview_urls === 'boolean') {
          worker.previewUrls = raw.preview_urls;
        }
        writeFileSync(workerPath, JSON.stringify(worker), { mode: 0o600 });
        await readBuildOutput(directory);
        return run(['workers', 'triggers', 'deploy', '--prebuilt'], command.capture, directory);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }

    if (args[0] === 'queues' && args[1] === 'consumer' && args[2] === 'remove') {
      const queueName = args[3];
      if (!queueName || args[4] !== workerName) {
        return failed('The Cloudflare Queue consumer target changed.');
      }
      const queues = run(['queues', 'list'], true);
      if (queues.status !== 0) {
        return queues;
      }
      const allQueues = parseJson(queues.stdout);
      if (!Array.isArray(allQueues)) {
        return failed('The Cloudflare Queue list was not readable.');
      }
      const queue = allQueues.find((item) => record(item) && item.queue_name === queueName);
      if (!record(queue) || typeof queue.queue_id !== 'string') {
        return failed(`Cloudflare Queue ${queueName} was not found.`);
      }
      const consumers = run(['queues', 'consumers', 'list', '--queue-id', queue.queue_id], true);
      if (consumers.status !== 0) {
        return consumers;
      }
      const allConsumers = parseJson(consumers.stdout);
      if (!Array.isArray(allConsumers)) {
        return failed('The Cloudflare Queue consumers were not readable.');
      }
      const matching = allConsumers.filter((item) => record(item) && item.script === workerName);
      if (matching.length === 0) {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (
        matching.length !== 1 ||
        !record(matching[0]) ||
        typeof matching[0].consumer_id !== 'string'
      ) {
        return failed('The Cloudflare Queue consumer identity was ambiguous.');
      }
      return run(
        [
          'queues',
          'consumers',
          'delete',
          matching[0].consumer_id,
          '--queue-id',
          queue.queue_id,
          '--force',
        ],
        command.capture,
      );
    }

    return failed(`Unsupported Cloudflare activation operation: ${args[0] ?? ''} ${args[1] ?? ''}`);
  };
}
