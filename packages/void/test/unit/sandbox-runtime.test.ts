import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { envContext } from '../../src/runtime/env-raw.ts';

const mocks = vi.hoisted(() => ({ getSandbox: vi.fn() }));
vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class {
    env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
  getSandbox: mocks.getSandbox,
}));
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

describe('Sandbox runtime', () => {
  it('preserves the upstream native client and options', async () => {
    const namespace = {};
    const native = { exec: vi.fn() };
    mocks.getSandbox.mockReturnValue(native);
    await envContext.run({ SANDBOX: namespace }, async () => {
      expect(await getSandbox('Workspace', { keepAlive: true })).toBe(native);
    });
    expect(mocks.getSandbox).toHaveBeenCalledWith(namespace, 'Workspace', {
      normalizeId: true,
      keepAlive: true,
    });
    expect(sandbox.get).toBe(getSandbox);
  });

  it('uses the configured native binding', async () => {
    __setSandboxBindingName('CUSTOM');
    const namespace = {};
    await envContext.run({ CUSTOM: namespace }, () => getSandbox());
    expect(mocks.getSandbox).toHaveBeenCalledWith(namespace, 'default', { normalizeId: true });
  });

  it('resolves a managed capability without touching a tenant namespace or acquiring a lease', async () => {
    const invoke = vi.fn().mockResolvedValue({ stdout: 'ok' });
    const resolve = vi.fn().mockResolvedValue({ invoke });
    await envContext.run(
      { __VOID_SANDBOX: { getSandbox: resolve }, __PROJECT_ID: 'project' },
      async () => {
        const client = await getSandbox('Workspace', { keepAlive: true });
        expect(invoke).not.toHaveBeenCalled();
        expect(await client.exec('echo ok')).toEqual({ stdout: 'ok' });
      },
    );
    expect(resolve).toHaveBeenCalledWith('Workspace', { normalizeId: true, keepAlive: true });
    expect(invoke).toHaveBeenCalledWith('exec', ['echo ok']);
    expect(mocks.getSandbox).not.toHaveBeenCalled();
  });

  it('preserves stream inputs, callbacks, and returned session/process operations', async () => {
    const stream = new ReadableStream<Uint8Array>();
    const callback = vi.fn();
    const sessionCapability = { invoke: vi.fn().mockResolvedValue('session result') };
    const processCapability = { invoke: vi.fn().mockResolvedValue('completed') };
    const session = {
      __voidSandboxType: 'session',
      id: 'session',
      capability: sessionCapability,
    };
    const process = {
      __voidSandboxType: 'process',
      id: 'process',
      command: 'sleep 1',
      status: 'running',
      startTime: new Date(),
      capability: processCapability,
    };
    const invoke = vi.fn(async (operation: string, args: Array<unknown>) => {
      if (operation === 'createSession') {
        return session;
      }
      if (operation === 'startProcess') {
        (args[1] as { onStart(process: unknown): void }).onStart(process);
        return process;
      }
      return stream;
    });
    await envContext.run({ __VOID_SANDBOX: { getSandbox: async () => ({ invoke }) } }, async () => {
      const client = await getSandbox();
      expect(await client.execStream('echo ok')).toBe(stream);
      await client.writeFile('/input', stream);
      await client.exec('echo ok', { onComplete: callback });
      const result = await client.createSession();
      expect(await result.exec('echo session')).toBe('session result');
      const onStart = vi.fn();
      const started = await client.startProcess('sleep 1', { onStart });
      expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ id: 'process' }));
      expect(await started.getStatus()).toBe('completed');
    });
    expect(invoke).toHaveBeenCalledWith('writeFile', ['/input', stream]);
    expect(invoke).toHaveBeenCalledWith('exec', ['echo ok', { onComplete: callback }]);
    expect(sessionCapability.invoke).toHaveBeenCalledWith('exec', ['echo session']);
    expect(processCapability.invoke).toHaveBeenCalledWith('getStatus', []);
  });

  it('forwards WebSocket/terminal requests and tunnel methods without JSON', async () => {
    const request = new Request('https://sandbox.test');
    const response = new Response('ok');
    const invoke = vi.fn().mockResolvedValue(response);
    await envContext.run({ __VOID_SANDBOX: { getSandbox: async () => ({ invoke }) } }, async () => {
      const client = await getSandbox();
      expect(await client.wsConnect(request, 8080)).toBe(response);
      await client.tunnels.list();
    });
    expect(invoke).toHaveBeenCalledWith('wsConnect', [request, 8080]);
    expect(invoke).toHaveBeenCalledWith('tunnels', ['list']);
  });

  it.each(['concurrency', 'runtime_budget'] as const)(
    'restores the typed %s error after RPC',
    async (reason) => {
      const invoke = vi.fn().mockRejectedValue(new Error(`VOID_SANDBOX_${reason}`));
      await envContext.run(
        { __VOID_SANDBOX: { getSandbox: async () => ({ invoke }) } },
        async () => {
          const client = await getSandbox();
          await expect(client.exec('echo ok')).rejects.toMatchObject({
            name: 'SandboxLimitError',
            reason,
          });
          await expect(client.exec('echo ok')).rejects.toBeInstanceOf(SandboxLimitError);
        },
      );
    },
  );

  it('rejects legacy managed namespaces without a controller', async () => {
    await envContext.run({ __PROJECT_ID: 'project', SANDBOX: {} }, async () => {
      await expect(getSandbox()).rejects.toBeInstanceOf(SandboxUnavailableError);
    });
    expect(mocks.getSandbox).not.toHaveBeenCalled();
  });

  it('does not mask ordinary SDK errors', async () => {
    const error = new TypeError('invalid path');
    await envContext.run(
      {
        __VOID_SANDBOX: {
          getSandbox: async () => ({
            invoke: async () => {
              throw error;
            },
          }),
        },
      },
      async () => {
        const client = await getSandbox();
        await expect(client.exec('echo ok')).rejects.toBe(error);
      },
    );
  });
});
