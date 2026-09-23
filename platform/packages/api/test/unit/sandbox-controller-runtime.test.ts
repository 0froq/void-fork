import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({ start: vi.fn(), getSandbox: vi.fn() }));
vi.mock('cloudflare:workers', () => ({
  RpcTarget: class {},
  WorkerEntrypoint: class {
    env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class {
    ctx: { container: { running: boolean } };
    env: unknown;
    schedules = new Map<string, unknown>();
    constructor(ctx: { container: { running: boolean } }, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
    async start() {
      mocks.start();
      this.ctx.container.running = true;
      await this.onStart();
    }
    async startAndWaitForPorts() {
      mocks.start();
      this.ctx.container.running = true;
      await this.onStart();
    }
    async onStart() {}
    async onStop() {}
    async onActivityExpired() {}
    deleteSchedules(name: string) {
      this.schedules.delete(name);
    }
    async schedule(seconds: number, name: string) {
      this.schedules.set(name, seconds);
    }
  },
  ContainerProxy: class {},
  getSandbox: mocks.getSandbox,
  isProcess: (value: unknown) =>
    !!value && typeof value === 'object' && 'kill' in value && 'getStatus' in value,
}));
import SandboxService, { SandboxController } from '../../src/sandbox-controller-runtime.ts';

function fixture() {
  const data = new Map<string, unknown>();
  const container = {
    running: false,
    destroy: vi.fn(async () => {
      container.running = false;
    }),
  };
  const control = {
    reserve: vi.fn().mockResolvedValue({ ok: true }),
    started: vi.fn().mockResolvedValue({ ok: true }),
    heartbeat: vi.fn().mockResolvedValue({ ok: true }),
    stopped: vi.fn().mockResolvedValue(undefined),
  };
  const ctx = {
    id: { toString: () => 'namespace-instance' },
    container,
    storage: {
      get: async (key: string) => structuredClone(data.get(key)),
      put: async (key: string, value: unknown) => {
        data.set(key, structuredClone(value));
      },
      delete: async (key: string) => data.delete(key),
    },
  };
  const env = { SANDBOX: {}, __VOID_SANDBOX_CONTROL: control };
  return {
    controller: new SandboxController(ctx as never, env as never),
    ctx,
    env,
    container,
    control,
    data,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('trusted Sandbox lifecycle', () => {
  it('reserves before starting and starts billing only after a running process exists', async () => {
    const f = fixture();
    f.control.reserve.mockImplementation(async () => {
      expect(f.container.running).toBe(false);
      return { ok: true };
    });
    f.control.started.mockImplementation(async () => {
      expect(f.container.running).toBe(true);
      return { ok: true };
    });
    await f.controller.start();
    expect(f.control.reserve).toHaveBeenCalledOnce();
    expect(f.control.started).toHaveBeenCalledWith('namespace-instance', expect.any(String));
    expect(f.control.stopped).not.toHaveBeenCalled();
    expect(f.data.get('__voidSandboxLease')).toMatchObject({ phase: 'running' });
  });

  it('never starts a container if admission fails', async () => {
    const f = fixture();
    f.control.reserve.mockResolvedValue({ ok: false, reason: 'concurrency' });
    await expect(f.controller.start()).rejects.toThrow('VOID_SANDBOX_concurrency');
    expect(mocks.start).not.toHaveBeenCalled();
    expect(f.control.started).not.toHaveBeenCalled();
    expect(f.container.running).toBe(false);
  });

  it('coalesces concurrent starts into one reservation and generation', async () => {
    const f = fixture();
    await Promise.all([f.controller.start(), f.controller.start(), f.controller.start()]);
    expect(f.control.reserve).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it('kills a booted container if startup confirmation is rejected', async () => {
    const f = fixture();
    f.control.started.mockResolvedValue({ ok: false, reason: 'runtime_budget' });
    await expect(f.controller.start()).rejects.toThrow('VOID_SANDBOX_runtime_budget');
    expect(f.container.destroy).toHaveBeenCalledOnce();
    expect(f.container.running).toBe(false);
    expect(f.control.stopped).toHaveBeenCalledOnce();
  });

  it('does not release a still-running process on idle notification or a premature stop callback', async () => {
    const f = fixture();
    await f.controller.start();
    await f.controller.onActivityExpired();
    await f.controller.onStop();
    expect(f.control.stopped).not.toHaveBeenCalled();
    expect(f.data.get('__voidSandboxLease')).toMatchObject({ phase: 'running' });
  });

  it('hard-kills on heartbeat denial before releasing its slot', async () => {
    const f = fixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await f.controller.start();
    f.control.heartbeat.mockResolvedValue({ ok: false, reason: 'runtime_budget' });
    f.control.stopped.mockImplementation(async () => {
      expect(f.container.running).toBe(false);
    });
    await f.controller.voidHeartbeat();
    expect(f.container.destroy).toHaveBeenCalledOnce();
    expect(f.control.stopped).toHaveBeenCalledOnce();
    expect(f.data.size).toBe(0);
  });

  it('kills on a stalled control call within a bounded deadline', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fixture();
    await f.controller.start();
    f.control.heartbeat.mockImplementation(() => new Promise(() => {}));
    const heartbeat = f.controller.voidHeartbeat();
    await vi.advanceTimersByTimeAsync(5_000);
    await heartbeat;
    expect(f.container.running).toBe(false);
    expect(f.control.stopped).toHaveBeenCalledOnce();
  });

  it('keeps a durable stopped generation for retry when final accounting is unavailable', async () => {
    const f = fixture();
    await f.controller.start();
    const generation = (f.data.get('__voidSandboxLease') as { generation: string }).generation;
    f.container.running = false;
    f.control.stopped.mockRejectedValueOnce(new Error('unavailable'));
    await expect(f.controller.onStop()).rejects.toThrow('unavailable');
    expect(f.data.get('__voidSandboxLease')).toEqual({ generation, phase: 'stopped' });
    await f.controller.voidHeartbeat();
    expect(f.control.stopped).toHaveBeenLastCalledWith('namespace-instance', generation);
    expect(f.data.size).toBe(0);
  });

  it('reconciles an interrupted startup before admitting a new generation', async () => {
    const f = fixture();
    f.data.set('__voidSandboxLease', { generation: 'orphan', phase: 'pending' });
    f.container.running = true;
    await f.controller.start();
    expect(f.container.destroy).toHaveBeenCalledOnce();
    expect(f.control.stopped).toHaveBeenCalledWith('namespace-instance', 'orphan');
    expect(f.control.reserve.mock.calls[0]?.[1]).not.toBe('orphan');
    expect(f.container.running).toBe(true);
  });
});

describe('Sandbox capability boundary', () => {
  function service() {
    const f = fixture();
    const stub = {
      configure: vi.fn().mockResolvedValue(undefined),
      exec: vi.fn().mockResolvedValue({ stdout: 'ok' }),
      callTunnels: vi.fn(),
      createSession: vi.fn(),
      startProcess: vi.fn(),
    };
    mocks.getSandbox.mockReturnValue(stub);
    return { service: new SandboxService({} as never, f.env as never), stub, f };
  }

  it('resolving a capability performs no admission and exposes no raw namespace or stub', async () => {
    const { service: host, f } = service();
    const capability = await host.getSandbox('default');
    expect(Object.keys(capability)).toEqual([]);
    expect(f.control.reserve).not.toHaveBeenCalled();
    expect(await capability.invoke('exec', ['echo ok'])).toEqual({ stdout: 'ok' });
  });

  it.each([
    'onStart',
    'onStop',
    'onActivityExpired',
    'alarm',
    'voidHeartbeat',
    'start',
    'startAndWaitForPorts',
    'schedule',
    'deleteSchedules',
    'configure',
    'constructor',
    '__proto__',
    'ctx',
    'env',
    'container',
    'client',
  ])('rejects %s', async (method) => {
    const { service: host } = service();
    await expect((await host.getSandbox('default')).invoke(method, [])).rejects.toThrow(
      'Unsupported Sandbox operation',
    );
  });

  it('rejects unknown configuration and only accepts supported options', async () => {
    const { service: host } = service();
    await expect(host.getSandbox('default', { env: {} } as never)).rejects.toThrow(
      'Unsupported Sandbox option',
    );
    await expect(host.getSandbox('default', { keepAlive: 'true' } as never)).rejects.toThrow(
      'boolean',
    );
    await expect(
      host.getSandbox('default', { containerTimeouts: { portReadyTimeoutMS: Infinity } }),
    ).rejects.toThrow('timeout');
    await expect(
      host.getSandbox('default', { keepAlive: true, sleepAfter: '10m' }),
    ).resolves.toBeDefined();
  });

  it('preserves session methods and streams as RPC-capable values', async () => {
    const { service: host, stub } = service();
    const stream = new ReadableStream();
    const session = { id: 'session', execStream: async () => stream };
    stub.createSession.mockResolvedValue(session);
    const result = (await (await host.getSandbox('default')).invoke('createSession', [])) as {
      __voidSandboxType: string;
      id: string;
      capability: { invoke(operation: string, args: Array<unknown>): Promise<unknown> };
    };
    expect(result).toMatchObject({ __voidSandboxType: 'session', id: 'session' });
    expect(await result.capability.invoke('execStream', [])).toBe(stream);
    await expect(result.capability.invoke('onStart', [])).rejects.toThrow(
      'Unsupported Sandbox session operation',
    );
  });

  it('returns restricted process capabilities and maps onStart callbacks', async () => {
    const { service: host, stub } = service();
    const process = {
      id: 'process',
      command: 'sleep 1',
      status: 'running',
      startTime: new Date(),
      kill: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockResolvedValue('completed'),
      getLogs: vi.fn(),
      waitForLog: vi.fn(),
      waitForPort: vi.fn(),
      waitForExit: vi.fn(),
    };
    stub.startProcess.mockImplementation(async (_command, options) => {
      options.onStart(process);
      return process;
    });
    const callback = vi.fn();
    const result = (await (
      await host.getSandbox('default')
    ).invoke('startProcess', ['sleep 1', { onStart: callback }])) as {
      capability: { invoke(operation: string, args: Array<unknown>): Promise<unknown> };
    };
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        __voidSandboxType: 'process',
        id: 'process',
      }),
    );
    expect(await result.capability.invoke('getStatus', [])).toBe('completed');
    await expect(result.capability.invoke('destroy', [])).rejects.toThrow(
      'Unsupported Sandbox process operation',
    );
  });

  it('limits tunnel dispatch to the SDK tunnel methods', async () => {
    const { service: host, stub } = service();
    const capability = await host.getSandbox('default');
    await capability.invoke('tunnels', ['list']);
    expect(stub.callTunnels).toHaveBeenCalledWith('list', []);
    await expect(capability.invoke('tunnels', ['constructor'])).rejects.toThrow(
      'Unsupported Sandbox tunnel',
    );
  });
});
