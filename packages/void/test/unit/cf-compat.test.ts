import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { expect, it } from 'vite-plus/test';
import { resolveWranglerArgv } from '../../src/cli/preset.ts';

it('reports an absent cf session as authentication failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'void-cf-no-auth-'));
  try {
    const [command, ...prefix] = resolveWranglerArgv(directory);
    const output = await new Promise<{ status: number; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          command!,
          [...prefix, 'whoami', '--json'],
          {
            cwd: directory,
            encoding: 'utf8',
            timeout: 20_000,
            env: {
              PATH: process.env.PATH,
              SYSTEMROOT: process.env.SYSTEMROOT,
              WINDIR: process.env.WINDIR,
              HOME: directory,
              USERPROFILE: directory,
              XDG_CONFIG_HOME: directory,
              CI: 'true',
            },
          },
          (error, stdout, stderr) => resolve({ status: error ? 1 : 0, stdout, stderr }),
        );
      },
    );
    expect(output.status, output.stdout).toBe(1);
    expect(JSON.parse(output.stdout)).toEqual({ loggedIn: false });
    expect(output.stderr).toContain('authentication is required');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

it('uses pinned cf despite a project-local CLI and preserves D1 results and the CF token alias', async () => {
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
    const local = join(directory, 'node_modules', 'cf');
    mkdirSync(local, { recursive: true });
    writeFileSync(join(directory, 'package.json'), '{}');
    writeFileSync(
      join(local, 'package.json'),
      JSON.stringify({ name: 'cf', version: '0.0.0', bin: { cf: 'fake.cjs' } }),
    );
    writeFileSync(join(local, 'fake.cjs'), 'console.log("UNPINNED_PROJECT_CF_EXECUTED");');
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

it('inspects existing Worker versions through an HTTP proxy', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'void-cf-proxy-contract-'));
  const versionId = '11111111-1111-4111-8111-111111111111';
  let proxied = 0;
  let inspected = 0;
  const api = createServer((request, response) => {
    inspected++;
    expect(request.url).toBe(
      `/client/v4/accounts/test-account/workers/scripts/test-worker/versions/${versionId}`,
    );
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        success: true,
        result: {
          resources: { bindings: [], script: { handlers: ['fetch'] }, script_runtime: {} },
        },
      }),
    );
  });
  const proxy = createServer();
  proxy.on('connect', (request, socket, head) => {
    proxied++;
    const [host, port] = request.url!.split(':');
    const upstream = connect(Number(port), host!, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) {
        upstream.write(head);
      }
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
  });
  await Promise.all([
    new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve)),
    new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve)),
  ]);
  try {
    const configPath = join(directory, 'wrangler.json');
    const preload = join(directory, 'mock-cf.mjs');
    writeFileSync(configPath, JSON.stringify({ name: 'test-worker', account_id: 'test-account' }));
    writeFileSync(
      preload,
      `import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
child.spawnSync = () => ({ status: 0, stdout: JSON.stringify({ id: '${versionId}', bindings: [] }), stderr: '' });
syncBuiltinESMExports();
`,
    );
    const entry = join(import.meta.dirname, '..', '..', 'src', 'cli', 'cf-compat.ts');
    const output = await new Promise<{ status: number; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          process.execPath,
          ['--import', preload, entry, 'versions', 'view', versionId, '-c', configPath],
          {
            cwd: directory,
            encoding: 'utf8',
            timeout: 10_000,
            env: {
              ...process.env,
              CLOUDFLARE_ACCOUNT_ID: 'test-account',
              CLOUDFLARE_API_TOKEN: 'synthetic-token',
              CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}/client/v4`,
              HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
              HTTPS_PROXY: '',
              NO_PROXY: '',
            },
          },
          (error, stdout, stderr) => resolve({ status: error ? 1 : 0, stdout, stderr }),
        );
      },
    );
    expect(output.status, output.stderr).toBe(0);
    expect(JSON.parse(output.stdout).resources.bindings).toEqual([]);
    expect(proxied).toBe(1);
    expect(inspected).toBe(1);
  } finally {
    await Promise.all(
      [api, proxy].map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
