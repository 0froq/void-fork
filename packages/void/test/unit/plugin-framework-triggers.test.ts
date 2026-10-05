import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toSlash } from 'pathslash';
import { build } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  analogDevTriggerInjectPlugin,
  astroDevTriggerInjectPlugin,
  frameworkTriggersDispatchPath,
  frameworkTriggersPlugin,
  nitroDevTriggerInjectPlugin,
} from '../../src/plugin-framework-triggers.ts';

const tempDirs: Array<string> = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-fw-triggers-'));
  tempDirs.push(root);
  return root;
}

function callConfigResolved(plugin: ReturnType<typeof frameworkTriggersPlugin>) {
  const hook = plugin.configResolved;
  const fn = typeof hook === 'function' ? hook : hook?.handler;
  if (typeof fn !== 'function') {
    throw new Error('configResolved not callable');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fn as any)({} as never);
}

type DevTrigger = (
  request: Request,
  env?: Record<string, unknown>,
  ctx?: unknown,
) => Promise<Response | null>;

async function loadDevTrigger(root: string): Promise<DevTrigger> {
  callConfigResolved(frameworkTriggersPlugin(root, { devTriggerToken: 'tk' }));
  const entry = frameworkTriggersDispatchPath(root);
  const outDir = join(root, '.void', 'test-output');
  // Bundle the emitted entry so its absolute imports also work under native ESM on Windows.
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    build: {
      ssr: entry,
      outDir,
      minify: false,
      rollupOptions: { output: { entryFileNames: 'dev-triggers.mjs' } },
    },
  });
  return (await import(pathToFileURL(join(outDir, 'dev-triggers.mjs')).href)).handleDevTrigger;
}

function triggerRequest(kind: 'scheduled' | 'queue', payload: unknown): Request {
  return new Request(`http://localhost/__void/${kind}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-void-dev-trigger': 'tk' },
    body: JSON.stringify(payload),
  });
}

function callConfigureServer(
  plugin:
    | ReturnType<typeof nitroDevTriggerInjectPlugin>
    | ReturnType<typeof astroDevTriggerInjectPlugin>
    | ReturnType<typeof analogDevTriggerInjectPlugin>,
  serverOverrides: Record<string, unknown> = {},
) {
  const hook = plugin.configureServer;
  const fn = typeof hook === 'function' ? hook : hook?.handler;
  if (typeof fn !== 'function') {
    throw new Error('configureServer not callable');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fn as any)({
    httpServer: { once() {} },
    middlewares: { use() {} },
    ...serverOverrides,
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('frameworkTriggersPlugin', () => {
  it('runs every job sharing a schedule once and skips unrelated jobs', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'crons'));
    for (const [name, crons] of [
      ['first', ['0 * * * *']],
      ['second', ['0 * * * *', '0 * * * *', '30 * * * *']],
      ['other', ['*/5 * * * *']],
    ] as const) {
      writeFileSync(
        join(root, 'crons', `${name}.mjs`),
        `export const cron = ${JSON.stringify(crons)};
export default (controller, env, ctx) => env.handlers.${name}(controller, env, ctx);`,
      );
    }
    const handle = await loadDevTrigger(root);
    const env = { handlers: { first: vi.fn(), second: vi.fn(), other: vi.fn() } };
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
    const response = await handle(
      triggerRequest('scheduled', { cron: '0 * * * *', scheduledTime: 1234 }),
      env,
      ctx,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: true });
    for (const handler of [env.handlers.first, env.handlers.second]) {
      expect(handler).toHaveBeenCalledExactlyOnceWith(
        { cron: '0 * * * *', scheduledTime: 1234, noRetry: expect.any(Function) },
        env,
        ctx,
      );
    }
    expect(env.handlers.other).not.toHaveBeenCalled();
  });

  it.each(['throw', 'reject'] as const)(
    'waits for sibling jobs before reporting a handler that can %s',
    async (failureMode) => {
      const root = createTempRoot();
      mkdirSync(join(root, 'crons'));
      writeFileSync(
        join(root, 'crons', 'first.mjs'),
        `export const cron = '0 * * * *';
export default (controller, env) => env.fail();`,
      );
      writeFileSync(
        join(root, 'crons', 'second.mjs'),
        `export const cron = '0 * * * *';
export default (controller, env) => env.sibling();`,
      );
      const handle = await loadDevTrigger(root);
      const failure = new Error('first job failed');
      let finishSibling: () => void = () => {};
      let markStarted: () => void = () => {};
      const pending = new Promise<void>((resolve) => {
        finishSibling = resolve;
      });
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const env = {
        fail: vi.fn(() => {
          if (failureMode === 'throw') {
            throw failure;
          }
          return Promise.reject(failure);
        }),
        sibling: vi.fn(() => {
          markStarted();
          return pending;
        }),
      };
      let settled = false;
      const outcome = handle(
        triggerRequest('scheduled', { cron: '0 * * * *', scheduledTime: 0 }),
        env,
      ).then(
        (response) => {
          settled = true;
          return response;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      try {
        await Promise.race([started, outcome]);
        expect(env.fail).toHaveBeenCalledOnce();
        expect(env.sibling).toHaveBeenCalledOnce();
        expect(settled).toBe(false);
      } finally {
        finishSibling();
      }
      const error = await outcome;
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) {
        throw new Error('Expected scheduled job failures');
      }
      expect(error.errors).toEqual([failure]);
    },
  );

  it('returns 404 when no job matches the requested schedule', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'crons'));
    writeFileSync(
      join(root, 'crons', 'hourly.mjs'),
      `export const cron = '0 * * * *';
export default (controller, env) => env.run();`,
    );
    const handle = await loadDevTrigger(root);
    const env = { run: vi.fn() };
    const response = await handle(
      triggerRequest('scheduled', { cron: '30 * * * *', scheduledTime: 0 }),
      env,
    );
    expect(response?.status).toBe(404);
    expect(await response?.json()).toEqual({ error: 'No cron handler matches "30 * * * *"' });
    expect(env.run).not.toHaveBeenCalled();
  });

  it('writes a dispatch module that imports each cron and queue handler', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'crons'), { recursive: true });
    mkdirSync(join(root, 'queues'), { recursive: true });
    writeFileSync(
      join(root, 'crons', 'a.ts'),
      'export const cron = "0 * * * *";\nexport default async () => {};\n',
    );
    writeFileSync(
      join(root, 'crons', 'b.ts'),
      'export const cron = "*/5 * * * *";\nexport default async () => {};\n',
    );
    writeFileSync(join(root, 'queues', 'emails.ts'), 'export default async () => {};\n');

    const plugin = frameworkTriggersPlugin(root, { devTriggerToken: 'dev-token-test' });
    callConfigResolved(plugin);

    const generated = readFileSync(frameworkTriggersDispatchPath(root), 'utf-8');
    expect(generated).toContain('@ts-nocheck');
    expect(generated).toContain(`__DEV_TRIGGER_TOKEN = "dev-token-test"`);
    expect(generated).toContain(`from ${JSON.stringify(toSlash(join(root, 'crons', 'a.ts')))}`);
    expect(generated).toContain(`from ${JSON.stringify(toSlash(join(root, 'crons', 'b.ts')))}`);
    expect(generated).toContain(
      `from ${JSON.stringify(toSlash(join(root, 'queues', 'emails.ts')))}`,
    );
    expect(generated).toContain('"0 * * * *"');
    expect(generated).toContain('export async function handleDevTrigger');
  });

  // The generated module embeds the dev trigger token, which is the whole
  // credential of the `/__void/inbox` routes — so it gets the same
  // owner-only mode as `.void/dev-trigger-token`. Windows has no
  // group/other bits, so there is nothing to assert there.
  it.skipIf(process.platform === 'win32')('writes the dispatch module owner-only (0600)', () => {
    const root = createTempRoot();
    const plugin = frameworkTriggersPlugin(root, { devTriggerToken: 'dev-token-test' });
    callConfigResolved(plugin);

    expect(statSync(frameworkTriggersDispatchPath(root)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')(
    'tightens a dispatch module left at 0644 by an earlier release',
    () => {
      const root = createTempRoot();
      const target = frameworkTriggersDispatchPath(root);
      mkdirSync(join(root, '.void'), { recursive: true });
      writeFileSync(target, '// stale\n', { mode: 0o644 });
      // Seed the legacy permissions even under a restrictive developer umask.
      chmodSync(target, 0o644);
      expect(statSync(target).mode & 0o777).toBe(0o644);

      const plugin = frameworkTriggersPlugin(root, { devTriggerToken: 'dev-token-test' });
      callConfigResolved(plugin);

      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(readFileSync(target, 'utf-8')).toContain(`__DEV_TRIGGER_TOKEN = "dev-token-test"`);
    },
  );

  it('emits handleDevTrigger that returns null for non-trigger requests', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'crons'), { recursive: true });
    writeFileSync(
      join(root, 'crons', 'a.ts'),
      'export const cron = "0 * * * *";\nexport default async () => {};\n',
    );

    const plugin = frameworkTriggersPlugin(root, { devTriggerToken: 'tk' });
    callConfigResolved(plugin);
    const code = readFileSync(frameworkTriggersDispatchPath(root), 'utf-8');

    expect(code).toMatch(
      /url\.pathname !== "\/__void\/scheduled"\s*&&\s*url\.pathname !== "\/__void\/queue"/,
    );
    expect(code).toContain('return null');
  });

  it('rejects requests with no auth headers', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'crons'), { recursive: true });
    writeFileSync(
      join(root, 'crons', 'a.ts'),
      'export const cron = "0 * * * *";\nexport default async () => {};\n',
    );

    const plugin = frameworkTriggersPlugin(root, { devTriggerToken: 'tk' });
    callConfigResolved(plugin);
    const code = readFileSync(frameworkTriggersDispatchPath(root), 'utf-8');
    expect(code).toContain('"unauthorized"');
    expect(code).toContain('x-void-internal');
    expect(code).toContain('x-void-dev-trigger');
  });
});

describe('nitroDevTriggerInjectPlugin', () => {
  it('writes Nuxt middleware to <root>/server/middleware/', () => {
    const root = createTempRoot();
    const plugin = nitroDevTriggerInjectPlugin(root, { serverDir: 'server' });
    callConfigureServer(plugin);

    const middlewarePath = join(root, 'server', 'middleware', '__void-dev-trigger.ts');
    expect(existsSync(middlewarePath)).toBe(true);
    const code = readFileSync(middlewarePath, 'utf-8');
    expect(code).toContain('@ts-nocheck');
    expect(code).toContain(`from "${frameworkTriggersDispatchPath(root)}"`);
    expect(code).toContain('event.context?.cloudflare');
    expect(code).toContain('event.node.req');
  });

  it('writes Analog middleware to <root>/src/server/middleware/', () => {
    const root = createTempRoot();
    const plugin = nitroDevTriggerInjectPlugin(root, { serverDir: 'src/server' });
    callConfigureServer(plugin);

    const middlewarePath = join(root, 'src', 'server', 'middleware', '__void-dev-trigger.ts');
    expect(existsSync(middlewarePath)).toBe(true);
  });

  it('appends middleware path to .gitignore', () => {
    const root = createTempRoot();
    const plugin = nitroDevTriggerInjectPlugin(root, { serverDir: 'server' });
    callConfigureServer(plugin);

    const gitignore = readFileSync(join(root, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('server/middleware/__void-dev-trigger.ts');
  });

  it('does not duplicate the .gitignore line on repeat invocations', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, '.gitignore'),
      'node_modules\nserver/middleware/__void-dev-trigger.ts\n',
    );
    const plugin = nitroDevTriggerInjectPlugin(root, { serverDir: 'server' });
    callConfigureServer(plugin);

    const gitignore = readFileSync(join(root, '.gitignore'), 'utf-8');
    const occurrences = gitignore
      .split('\n')
      .filter((l) => l.trim() === 'server/middleware/__void-dev-trigger.ts').length;
    expect(occurrences).toBe(1);
  });
});

describe('astroDevTriggerInjectPlugin', () => {
  it('writes src/middleware.ts when no user middleware exists', () => {
    const root = createTempRoot();
    const plugin = astroDevTriggerInjectPlugin(root);
    callConfigureServer(plugin);

    const middlewarePath = join(root, 'src', 'middleware.ts');
    expect(existsSync(middlewarePath)).toBe(true);
    const code = readFileSync(middlewarePath, 'utf-8');
    expect(code).toContain("from 'cloudflare:workers'");
    expect(code).toContain(`from "${frameworkTriggersDispatchPath(root)}"`);
  });

  it('warns and skips when src/middleware.ts already exists', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'src'), { recursive: true });
    const existing = '// user middleware\nexport const onRequest = () => {};\n';
    writeFileSync(join(root, 'src', 'middleware.ts'), existing);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const plugin = astroDevTriggerInjectPlugin(root);
    callConfigureServer(plugin);

    // User file untouched
    expect(readFileSync(join(root, 'src', 'middleware.ts'), 'utf-8')).toBe(existing);
    // Warned
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'Astro middleware already exists',
    );
  });
});

describe('analogDevTriggerInjectPlugin', () => {
  it('writes scheduled + queue route files under src/server/routes/api/__void/', () => {
    const root = createTempRoot();
    const plugin = analogDevTriggerInjectPlugin(root);
    callConfigureServer(plugin);

    const cron = join(root, 'src', 'server', 'routes', 'api', '__void', 'cron-trigger.ts');
    const queue = join(root, 'src', 'server', 'routes', 'api', '__void', 'queue-trigger.ts');
    expect(existsSync(cron)).toBe(true);
    expect(existsSync(queue)).toBe(true);

    const cronCode = readFileSync(cron, 'utf-8');
    expect(cronCode).toContain('@ts-nocheck');
    expect(cronCode).toContain(`from "${frameworkTriggersDispatchPath(root)}"`);
    expect(cronCode).toContain("from 'h3'");
    expect(cronCode).toContain('http://localhost/__void/scheduled');
    expect(cronCode).toContain('event.context?.cloudflare');
  });

  it('appends both route paths to .gitignore', () => {
    const root = createTempRoot();
    const plugin = analogDevTriggerInjectPlugin(root);
    callConfigureServer(plugin);

    const gitignore = readFileSync(join(root, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('src/server/routes/api/__void/cron-trigger.ts');
    expect(gitignore).toContain('src/server/routes/api/__void/queue-trigger.ts');
  });

  it('registers a Vite middleware for the URL proxy', () => {
    const root = createTempRoot();
    const plugin = analogDevTriggerInjectPlugin(root);
    let registered = 0;
    callConfigureServer(plugin, {
      middlewares: {
        use() {
          registered += 1;
        },
      },
    });
    expect(registered).toBeGreaterThan(0);
  });
});
