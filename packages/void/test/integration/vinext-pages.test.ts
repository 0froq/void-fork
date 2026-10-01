import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  getPort,
  waitForServer,
  killChild,
  collectServerOutput,
} from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = 'playground/vinext-pages';
let DEV_PORT: number;
let DEV_BASE: string;

describe('playground/vinext-pages dev', () => {
  let child: ReturnType<typeof spawn>;
  let serverOutput = () => '';

  beforeAll(async () => {
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

    serverOutput = collectServerOutput(child);

    await waitForServer(DEV_BASE, 20_000, {
      isAlive: () => child.exitCode === null && child.signalCode === null,
      diagnostics: serverOutput,
    });
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    if (serverOutput().includes('error when starting dev server')) {
      throw new Error(serverOutput());
    }
  });

  it('renders home page with SSR', async () => {
    const response = await fetch(`${DEV_BASE}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('vinext Pages Router + Void');
  });

  it('smoke route exercises D1 and KV', async () => {
    const response = await fetch(`${DEV_BASE}/smoke`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Alice');
    expect(html).toContain('ok');
  });
});
