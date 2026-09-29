import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import spawn from 'cross-spawn';
import { parse } from 'jsonc-parser';
import { join } from 'pathslash';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { getPort, waitForServer, killChild } from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = 'playground/analog';
const PLAYGROUND_ROOT = join(ROOT, PLAYGROUND);
const CONFIG_FILES = [
  'void.config.ts',
  'void.lock.json',
  '.void-wrangler.jsonc',
  'wrangler.jsonc',
  'wrangler.json',
];
const configSnapshot = new Map<string, string | undefined>();

function removeWranglerConfig(root: string) {
  rmSync(join(root, 'wrangler.jsonc'), { force: true });
  rmSync(join(root, 'wrangler.json'), { force: true });
}

beforeAll(() => {
  for (const file of CONFIG_FILES) {
    const filePath = join(PLAYGROUND_ROOT, file);
    configSnapshot.set(file, existsSync(filePath) ? readFileSync(filePath, 'utf-8') : undefined);
  }
});

afterAll(() => {
  for (const [file, contents] of configSnapshot) {
    const filePath = join(PLAYGROUND_ROOT, file);
    if (contents === undefined) {
      rmSync(filePath, { force: true });
    } else {
      writeFileSync(filePath, contents);
    }
  }
});

describe('playground/analog dev', () => {
  let child: ReturnType<typeof spawn>;
  let DEV_PORT: number;
  let DEV_BASE: string;

  beforeAll(async () => {
    const pg = PLAYGROUND_ROOT;
    rmSync(join(pg, '.void'), { recursive: true, force: true });
    rmSync(join(pg, '.wrangler'), { recursive: true, force: true });
    removeWranglerConfig(pg);

    DEV_PORT = await getPort();
    DEV_BASE = `http://127.0.0.1:${DEV_PORT}`;

    child = spawn(
      'vp',
      [
        'run',
        '--filter',
        `./${PLAYGROUND}`,
        'dev',
        '--host',
        '127.0.0.1',
        '--port',
        String(DEV_PORT),
      ],
      {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          VOID_INSPECTOR_PORT: 'false',
        },
      },
    );

    child.stderr!.on('data', () => {});

    // Analog's first dev boot compiles the Angular app. Under a fully parallel test run that can
    // exceed the normal 30s readiness window even though subsequent requests are fast.
    await waitForServer(DEV_BASE, 60_000);
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
  });

  it('syncs the generated Cloudflare config with bindings from void.config.ts', () => {
    const wranglerConfig = parse(
      readFileSync(join(ROOT, `${PLAYGROUND}/.void-wrangler.jsonc`), 'utf-8'),
    ) as {
      d1_databases?: Array<{ binding: string }>;
      kv_namespaces?: Array<{ binding: string }>;
    };

    expect(wranglerConfig.d1_databases?.some((b) => b.binding === 'DB')).toBe(true);
    expect(wranglerConfig.kv_namespaces?.some((b) => b.binding === 'KV')).toBe(true);
    expect(existsSync(join(ROOT, `${PLAYGROUND}/wrangler.jsonc`))).toBe(false);
  });
});
