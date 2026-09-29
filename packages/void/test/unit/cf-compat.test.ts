import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { expect, it } from 'vite-plus/test';
import { resolveWranglerArgv } from '../../src/cli/preset.ts';

it('uses cf for remote D1 SQL and preserves the existing result shape and CF token alias', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'void-cf-d1-contract-'));
  const requests: Array<{ method: string; path: string; authorization: string | undefined }> = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? '',
      path: request.url ?? '',
      authorization: request.headers.authorization,
    });
    request.resume();
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        success: true,
        errors: [],
        messages: [],
        result: [{ results: [{ name: '0001_setup.sql' }], success: true, meta: {} }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        account_id: 'test-account',
        d1_databases: [{ binding: 'DB', database_id: 'test-database' }],
      }),
    );
    const [command, ...prefix] = resolveWranglerArgv(directory);
    const output = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          command!,
          [
            ...prefix,
            'd1',
            'execute',
            'DB',
            '--remote',
            '--command',
            'SELECT name FROM d1_migrations',
            '--json',
            '-c',
            configPath,
            '--env=',
          ],
          {
            cwd: directory,
            encoding: 'utf8',
            timeout: 20_000,
            env: {
              PATH: process.env.PATH,
              SYSTEMROOT: process.env.SYSTEMROOT,
              WINDIR: process.env.WINDIR,
              TMP: process.env.TMP,
              TEMP: process.env.TEMP,
              CI: 'true',
              CF_API_TOKEN: 'synthetic-token',
              CLOUDFLARE_ACCOUNT_ID: 'test-account',
              CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`,
            },
          },
          (_error, stdout, stderr) => resolve({ status: _error ? 1 : 0, stdout, stderr }),
        );
      },
    );
    expect(output.status, output.stderr).toBe(0);
    expect(JSON.parse(output.stdout)).toEqual([
      { results: [{ name: '0001_setup.sql' }], success: true, meta: {} },
    ]);
    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/client/v4/accounts/test-account/d1/database/test-database/query',
        authorization: 'Bearer synthetic-token',
      },
    ]);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
