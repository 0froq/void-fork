import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

const root = join(import.meta.dirname, '..', '..', '..', '..');
const temporary = mkdtempSync(join(tmpdir(), 'void-sandbox-rpc-'));
const output = join(temporary, 'dist');
type Runtime = { dispatchFetch(url: string): Promise<Response>; dispose(): Promise<void> };
let runtime: Runtime;

describe('Managed Sandbox through actual Workers RPC', () => {
  beforeAll(async () => {
    const application = join(temporary, 'application.ts');
    const controller = join(temporary, 'controller.ts');
    writeFileSync(
      controller,
      `
import { RpcTarget, WorkerEntrypoint } from 'cloudflare:workers';
const bytes = (value) => new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(value)); controller.close(); } });
class Nested extends RpcTarget {
  constructor(kind) { super(); this.kind = kind; }
  async invoke(operation, args) {
    if (this.kind === 'session' && operation === 'execStream') return bytes('session stream');
    if (this.kind === 'process' && operation === 'getStatus') return 'completed';
    throw new TypeError('nested operation denied');
  }
}
const process = () => ({
  __voidSandboxType: 'process', capability: new Nested('process'), id: 'process-1',
  command: 'sleep 1', status: 'running', startTime: new Date('2026-09-24T00:00:00Z'),
});
class Capability extends RpcTarget {
  async invoke(operation, args) {
    if (operation === 'execStream') return bytes('root stream');
    if (operation === 'createSession') return { __voidSandboxType: 'session', capability: new Nested('session'), id: 'session-1' };
    if (operation === 'startProcess') { await args[1].onStart(process()); return process(); }
    throw new TypeError('operation denied');
  }
}
export default class extends WorkerEntrypoint {
  async getSandbox() { return new Capability(); }
  fetch() { return new Response('Not found', { status: 404 }); }
}
`,
    );
    writeFileSync(
      application,
      `
import { getSandbox } from ${JSON.stringify(join(root, 'packages/void/src/runtime/sandbox.ts'))};
const text = async (stream) => new TextDecoder().decode(await new Response(stream).arrayBuffer());
export default { async fetch(request) {
  const sandbox = await getSandbox('default');
  const path = new URL(request.url).pathname;
  if (path === '/stream') return new Response(await text(await sandbox.execStream('echo ok')));
  if (path === '/session') { const session = await sandbox.createSession(); return new Response(session.id + ':' + await text(await session.execStream('echo ok'))); }
  if (path === '/process') {
    let callback = '';
    const process = await sandbox.startProcess('sleep 1', { onStart(value) { callback = value.id; } });
    return Response.json({ callback, id: process.id, status: await process.getStatus() });
  }
  try { await sandbox.onStart(); } catch (error) { return new Response(error.message, { status: 400 }); }
  return new Response('unexpected');
} };
`,
    );
    for (const [name, entry] of [
      ['application', application],
      ['controller', controller],
    ] as const) {
      await build({
        configFile: false,
        logLevel: 'silent',
        ssr: { noExternal: true },
        build: {
          outDir: output,
          emptyOutDir: name === 'application',
          ssr: entry,
          target: 'esnext',
          rollupOptions: {
            external: [/^cloudflare:/, /^node:/],
            output: { entryFileNames: `${name}.mjs`, codeSplitting: false },
          },
        },
      });
    }
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        compatibilityDate: '2026-09-01',
        compatibilityFlags: ['nodejs_compat'],
        workers: [
          {
            name: 'application',
            compatibilityDate: '2026-07-01',
            compatibilityFlags: ['nodejs_compat'],
            modules: true,
            modulesRoot: output,
            scriptPath: join(output, 'application.mjs'),
            routes: ['*/*'],
            serviceBindings: { __VOID_SANDBOX: 'controller' },
          },
          {
            name: 'controller',
            compatibilityDate: '2026-07-01',
            compatibilityFlags: ['nodejs_compat'],
            modules: true,
            modulesRoot: output,
            scriptPath: join(output, 'controller.mjs'),
          },
        ],
      }),
    ) as unknown as Runtime;
  }, 30_000);

  afterAll(async () => {
    await runtime?.dispose();
    rmSync(temporary, { recursive: true, force: true });
  });

  it('transfers streams through root and session capabilities', async () => {
    expect(await (await runtime.dispatchFetch('http://localhost/stream')).text()).toBe(
      'root stream',
    );
    expect(await (await runtime.dispatchFetch('http://localhost/session')).text()).toBe(
      'session-1:session stream',
    );
  });

  it('transfers process callbacks and restricted process methods', async () => {
    expect(await (await runtime.dispatchFetch('http://localhost/process')).json()).toEqual({
      callback: 'process-1',
      id: 'process-1',
      status: 'completed',
    });
  });

  it('surfaces rejection of lifecycle methods across RPC', async () => {
    const response = await runtime.dispatchFetch('http://localhost/denied');
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('operation denied');
  });
});
