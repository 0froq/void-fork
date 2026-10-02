import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
vi.mock('@cloudflare/sandbox', () => ({
  Files: class {},
  DirectoryBackup: class {},
  DirectoryBackupGateway: class {},
  S3Mount: class {},
  S3Gateway: class {},
}));
vi.mock('cloudflare:workers', () => ({ DurableObject: class {}, RpcTarget: class {} }));
import { envContext } from '../../src/runtime/env-raw.ts';
import {
  getSandbox,
  sandbox,
  __setSandboxBindingName,
  SandboxLimitError,
  SandboxUnavailableError,
} from '../../src/runtime/sandbox.ts';

afterEach(() => {
  vi.clearAllMocks();
  __setSandboxBindingName('SANDBOX');
});
const bytes = (value: string) => new Blob([value]).stream();
function capability() {
  const processInvoke = vi.fn().mockResolvedValue(0);
  const invoke = vi.fn().mockResolvedValue({
    pid: 42,
    isPty: false,
    stdin: null,
    stdout: bytes('ok'),
    stderr: bytes(''),
    capability: { invoke: processInvoke },
  });
  return { invoke, processInvoke };
}

describe('Sandbox runtime', () => {
  it('resolves native containers by normalized name and configures without starting', async () => {
    const c = capability();
    const configure = vi.fn();
    const getByName = vi.fn().mockReturnValue({ invoke: c.invoke, configure });
    await envContext.run({ SANDBOX: { getByName } }, async () => {
      const client = await getSandbox('Workspace', { inactivityTimeoutMs: 1000 });
      expect(c.invoke).not.toHaveBeenCalled();
      const process = await client.exec(['echo', 'ok']).match({
        ok: (value) => value,
        limited: (limit) => {
          throw limit;
        },
      });
      const result = await process.output().match({
        ok: (value) => value,
        limited: (limit) => {
          throw limit;
        },
      });
      expect(new TextDecoder().decode(result.stdout)).toBe('ok');
      expect(result.exitCode).toBe(0);
    });
    expect(getByName).toHaveBeenCalledWith('workspace');
    expect(configure).toHaveBeenCalledWith({ inactivityTimeoutMs: 1000 });
    expect(sandbox.get).toBe(getSandbox);
  });
  it('uses the configured native binding and can preserve case', async () => {
    __setSandboxBindingName('CUSTOM');
    const getByName = vi.fn().mockReturnValue({ configure: vi.fn(), invoke: vi.fn() });
    await envContext.run({ CUSTOM: { getByName } }, () =>
      getSandbox('Workspace', { normalizeId: false }),
    );
    expect(getByName).toHaveBeenCalledWith('Workspace');
  });
  it('uses managed capabilities and native execution results', async () => {
    const c = capability();
    const resolve = vi.fn().mockResolvedValue({ invoke: c.invoke });
    await envContext.run(
      { __VOID_SANDBOX: { getSandbox: resolve }, __PROJECT_ID: 'project' },
      async () => {
        const client = await getSandbox('Workspace');
        const process = await client.exec(['node', '--version']).match({
          ok: (value) => value,
          limited: (limit) => {
            throw limit;
          },
        });
        expect(process.pid).toBe(42);
        await process.kill(9);
        await process.resize(80, 24);
        expect(
          await process.exitCode.match({
            ok: (value) => value,
            limited: (limit) => {
              throw limit;
            },
          }),
        ).toBe(0);
        await client.files.writeFile('/input', bytes('input')).match({
          ok: (value) => value,
          limited: (limit) => {
            throw limit;
          },
        });
      },
    );
    expect(resolve).toHaveBeenCalledWith('workspace', {});
    expect(c.invoke).toHaveBeenCalledWith('exec', [['node', '--version'], undefined]);
    expect(c.processInvoke).toHaveBeenCalledWith('kill', [9]);
    expect(c.processInvoke).toHaveBeenCalledWith('resize', [80, 24]);
    expect(c.invoke).toHaveBeenCalledWith('files', [
      'writeFile',
      '/input',
      expect.any(ReadableStream),
      undefined,
    ]);
  });
  it('encodes aborts as cancellable RPC streams and rejects an already aborted signal', async () => {
    const c = capability();
    const controller = new AbortController();
    await envContext.run({ __VOID_SANDBOX: { getSandbox: async () => c } }, async () => {
      const client = await getSandbox();
      await client.exec(['sleep', '10'], { signal: controller.signal }).match({
        ok: (value) => value,
        limited: (limit) => {
          throw limit;
        },
      });
      const encoded = c.invoke.mock.calls[0]![1][1] as { abort: ReadableStream; signal?: unknown };
      expect(encoded.signal).toBeUndefined();
      const reader = encoded.abort.getReader();
      controller.abort();
      expect(await reader.read()).toEqual({ done: true, value: undefined });
      await expect(
        client.exec(['true'], { signal: controller.signal }).match({
          ok: (value) => value,
          limited: (limit) => {
            throw limit;
          },
        }),
      ).rejects.toThrow();
    });
  });
  it.each(['exec', 'files'] as const)(
    'releases cancellation listeners when %s fails before consuming the RPC stream',
    async (operation) => {
      const controller = new AbortController();
      const add = vi.spyOn(controller.signal, 'addEventListener');
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      const invoke = vi.fn().mockRejectedValue(new Error('admission failed'));
      await envContext.run(
        { __VOID_SANDBOX: { getSandbox: async () => ({ invoke }) } },
        async () => {
          const client = await getSandbox();
          await expect(
            operation === 'exec'
              ? client.exec(['true'], { signal: controller.signal }).match({
                  ok: (value) => value,
                  limited: (limit) => {
                    throw limit;
                  },
                })
              : client.files.readFile('/file', { signal: controller.signal }).match({
                  ok: (value) => value,
                  limited: (limit) => {
                    throw limit;
                  },
                }),
          ).rejects.toThrow('admission failed');
          expect(add).toHaveBeenCalledOnce();
          expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1]);
          const args = invoke.mock.calls[0]![1];
          const encoded = args[operation === 'exec' ? 1 : 2] as { abort: ReadableStream };
          expect(await encoded.abort.getReader().read()).toEqual({ done: true, value: undefined });
        },
      );
    },
  );
  it.each(['concurrency', 'runtime_budget'] as const)(
    'restores typed %s errors after RPC',
    async (reason) => {
      const invoke = vi.fn().mockRejectedValue(new Error(`VOID_SANDBOX_${reason}`));
      await envContext.run(
        { __VOID_SANDBOX: { getSandbox: async () => ({ invoke }) } },
        async () => {
          const client = await getSandbox();
          await expect(
            client.exec(['true']).match({
              ok: (value) => value,
              limited: (limit) => {
                throw limit;
              },
            }),
          ).rejects.toBeInstanceOf(SandboxLimitError);
          await expect(
            client.exec(['true']).match({
              ok: (value) => value,
              limited: (limit) => {
                throw limit;
              },
            }),
          ).rejects.toMatchObject({ reason });
        },
      );
    },
  );
  it('rejects legacy namespaces, custom managed bindings and removed SDK options', async () => {
    await envContext.run({ __PROJECT_ID: 'project', SANDBOX: {} }, async () => {
      await expect(getSandbox()).rejects.toBeInstanceOf(SandboxUnavailableError);
    });
    await envContext.run({ __VOID_SANDBOX: {} }, async () => {
      await expect(getSandbox('default', { binding: 'CUSTOM' })).rejects.toBeInstanceOf(
        SandboxUnavailableError,
      );
      await expect(getSandbox('default', { keepAlive: true } as never)).rejects.toThrow(
        'Unsupported Sandbox option',
      );
      await expect(getSandbox('', {})).rejects.toThrow('Sandbox id');
    });
  });
  it('preserves file responses and ordinary SDK errors', async () => {
    const response = new Response(bytes('file'));
    const error = new TypeError('invalid path');
    const invoke = vi.fn().mockResolvedValueOnce(response).mockRejectedValueOnce(error);
    await envContext.run({ __VOID_SANDBOX: { getSandbox: async () => ({ invoke }) } }, async () => {
      const client = await getSandbox();
      expect(
        await (
          await client.files.readFile('/file').match({
            ok: (value) => value,
            limited: (limit) => {
              throw limit;
            },
          })
        ).text(),
      ).toBe('file');
      await expect(
        client.files.readFile('/bad').match({
          ok: (value) => value,
          limited: (limit) => {
            throw limit;
          },
        }),
      ).rejects.toBe(error);
    });
  });
});

describe('mandatory Sandbox outcomes', () => {
  it('handles a quota on process completion after successful admission', async () => {
    const c = capability();
    c.processInvoke.mockRejectedValue(new Error('VOID_SANDBOX_runtime_budget'));
    await envContext.run({ __VOID_SANDBOX: { getSandbox: async () => c } }, async () => {
      const client = await getSandbox();
      const op = client.run(['work']);
      expect(c.invoke).not.toHaveBeenCalled();
      const ok = vi.fn();
      const response = await op.match({
        ok,
        limited: (limit) => limit.response({ message: 'Execution allowance exhausted' }),
      });
      expect(ok).not.toHaveBeenCalled();
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({
        resource: 'sandbox',
        reason: 'runtime_budget',
      });
      c.invoke.mockResolvedValue(undefined);
      await client.destroy();
      expect(c.invoke).toHaveBeenLastCalledWith('destroy', []);
    });
  });
  it.each(['exec', 'file', 'fetch'] as const)(
    'requires a fallback for %s before starting work',
    async (method) => {
      const invoke = vi.fn().mockRejectedValue(new Error('VOID_SANDBOX_concurrency'));
      await envContext.run(
        { __VOID_SANDBOX: { getSandbox: async () => ({ invoke }) } },
        async () => {
          const client = await getSandbox();
          const op =
            method === 'exec'
              ? client.exec(['work'])
              : method === 'file'
                ? client.files.readFile('/data')
                : client.fetch(8080, new Request('http://sandbox'));
          const ok = vi.fn();
          expect(await op.match({ ok, limited: (limit) => limit.reason })).toBe('concurrency');
          expect(ok).not.toHaveBeenCalled();
        },
      );
    },
  );
});
