import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { expect, it } from 'vite-plus/test';
import { withConditionalPlatformWorkerCreate } from '../../src/cli/platform-installer.ts';
import { resolveWranglerArgv } from '../../src/cli/preset.ts';

it('accepts the bundled uploader query while preserving the create-only precondition', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'void-worker-upload-contract-'));
  const uploads: Array<{ url: string; precondition: string | undefined }> = [];
  const requests: Array<string> = [];
  // This is a local fake API. A synthetic credential and isolated config ensure
  // this contract test cannot deploy to any real Cloudflare account.
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    requests.push(`${request.method} ${url}`);
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'PUT') {
      uploads.push({ url, precondition: request.headers['if-none-match'] });
      request.resume();
      response.writeHead(412);
      response.end(
        JSON.stringify({
          success: false,
          errors: [{ code: 1000, message: 'Simulated concurrent creation.' }],
        }),
      );
    } else if (url.endsWith('/workers/subdomain')) {
      response.end(JSON.stringify({ success: true, result: { subdomain: 'test' } }));
    } else {
      response.writeHead(404);
      response.end(
        JSON.stringify({ success: false, errors: [{ code: 10007, message: 'Worker not found.' }] }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`;
  try {
    writeFileSync(
      join(directory, 'worker.mjs'),
      'export default { fetch() { return new Response("local test"); } };',
    );
    const config = join(directory, 'wrangler.json');
    writeFileSync(
      config,
      JSON.stringify({
        name: 'void-contract',
        account_id: 'account',
        main: 'worker.mjs',
        compatibility_date: '2026-02-24',
        workers_dev: false,
        preview_urls: false,
        no_bundle: true,
      }),
    );
    const [command, ...prefix] = resolveWranglerArgv(process.cwd());
    let output = '';
    const failure = await withConditionalPlatformWorkerCreate(
      'account',
      'void-contract',
      async (apiBase) => {
        await new Promise<void>((resolve) => {
          const child = execFile(
            command!,
            [
              ...prefix,
              'deploy',
              '--config',
              config,
              '--strict',
              '--experimental-provision=false',
              '--experimental-auto-create=false',
              '--autoconfig=false',
            ],
            {
              cwd: directory,
              encoding: 'utf8',
              timeout: 20_000,
              maxBuffer: 1024 * 1024,
              env: {
                PATH: process.env.PATH,
                SYSTEMROOT: process.env.SYSTEMROOT,
                WINDIR: process.env.WINDIR,
                TMP: process.env.TMP,
                TEMP: process.env.TEMP,
                CI: 'true',
                CLOUDFLARE_API_TOKEN: 'synthetic-token',
                CLOUDFLARE_API_BASE_URL: apiBase,
                WRANGLER_SEND_METRICS: 'false',
                WRANGLER_LOG_PATH: join(directory, 'logs'),
              },
            },
            (_error, stdout, stderr) => {
              output = stdout + stderr;
              resolve();
            },
          );
          child.stdin?.end();
        });
      },
      origin,
    ).catch((error: unknown) => error);
    expect(String(failure), output + '\n' + requests.join('\n')).toContain(
      'created concurrently (HTTP 412)',
    );
    expect(uploads).toHaveLength(1);
    const url = new URL(uploads[0]!.url, origin);
    expect(url.pathname).toBe('/client/v4/accounts/account/workers/scripts/void-contract');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      excludeScript: 'true',
      bindings_inherit: 'strict',
    });
    expect(uploads[0]!.precondition).toBe('*');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
