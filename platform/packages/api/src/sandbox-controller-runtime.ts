import {
  Sandbox,
  getSandbox,
  isProcess,
  type ExecutionSession,
  type Process,
  type ProcessOptions,
  type SandboxOptions,
} from '@cloudflare/sandbox';
import { RpcTarget, WorkerEntrypoint } from 'cloudflare:workers';

// Required by the SDK's bucket mounts and outbound interception. This class is
// platform code; neither it nor the raw namespace is bound to the application.
export { ContainerProxy } from '@cloudflare/sandbox';

type Admission = { ok: true } | { ok: false; reason: string };
type Control = {
  reserve(instanceId: string, generation: string): Promise<Admission>;
  started(instanceId: string, generation: string): Promise<Admission>;
  heartbeat(instanceId: string, generation: string): Promise<Admission>;
  stopped(instanceId: string, generation: string): Promise<void>;
};
type ControllerEnv = {
  SANDBOX: DurableObjectNamespace<SandboxController>;
  __VOID_SANDBOX_CONTROL: Control;
};
type Lease = { generation: string; phase: 'pending' | 'running' | 'stopped' };
const LEASE_KEY = '__voidSandboxLease';
const HEARTBEAT_SECONDS = 30;
const CONTROL_TIMEOUT_MS = 5_000;

// Only application operations cross the capability boundary. In particular,
// do not forward arbitrary inherited Container/DO methods or SDK properties.
const OPERATIONS = new Set([
  'exec',
  'execStream',
  'startProcess',
  'listProcesses',
  'getProcess',
  'killProcess',
  'killAllProcesses',
  'cleanupCompletedProcesses',
  'getProcessLogs',
  'streamProcessLogs',
  'writeFile',
  'readFile',
  'readFileStream',
  'watch',
  'checkChanges',
  'mkdir',
  'deleteFile',
  'renameFile',
  'moveFile',
  'listFiles',
  'exists',
  'gitCheckout',
  'setEnvVars',
  'mountBucket',
  'unmountBucket',
  'createSession',
  'getSession',
  'deleteSession',
  'getContainerPlacementId',
  'createCodeContext',
  'runCode',
  'runCodeStream',
  'listCodeContexts',
  'deleteCodeContext',
  'createBackup',
  'restoreBackup',
  'exposePort',
  'unexposePort',
  'getExposedPorts',
  'isPortExposed',
  'validatePortToken',
  'terminal',
  'wsConnect',
  'fetch',
  'destroy',
  'stop',
  'getState',
  'setSleepAfter',
  'setKeepAlive',
  'setContainerTimeouts',
  'setTransport',
  'setLabels',
]);
const OPTIONS = new Set([
  'sleepAfter',
  'keepAlive',
  'enableDefaultSession',
  'normalizeId',
  'containerTimeouts',
  'transport',
  'labels',
]);
const SESSION_OPERATIONS = new Set([
  'exec',
  'execStream',
  'startProcess',
  'listProcesses',
  'getProcess',
  'killProcess',
  'killAllProcesses',
  'cleanupCompletedProcesses',
  'getProcessLogs',
  'streamProcessLogs',
  'writeFile',
  'readFile',
  'readFileStream',
  'watch',
  'checkChanges',
  'mkdir',
  'deleteFile',
  'renameFile',
  'moveFile',
  'listFiles',
  'exists',
  'gitCheckout',
  'setEnvVars',
  'mountBucket',
  'unmountBucket',
  'createCodeContext',
  'runCode',
  'runCodeStream',
  'listCodeContexts',
  'deleteCodeContext',
  'createBackup',
  'restoreBackup',
  'terminal',
]);
const PROCESS_OPERATIONS = new Set([
  'kill',
  'getStatus',
  'getLogs',
  'waitForLog',
  'waitForPort',
  'waitForExit',
]);

type ProcessWire = Readonly<{
  __voidSandboxType: 'process';
  capability: ProcessCapability;
  command: string;
  endTime?: Date;
  exitCode?: number;
  id: string;
  pid?: number;
  sessionId?: string;
  startTime: Date;
  status: Process['status'];
}>;

type SessionWire = Readonly<{
  __voidSandboxType: 'session';
  capability: SessionCapability;
  id: string;
}>;

function validateOptions(options: SandboxOptions): void {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Sandbox options must be an object.');
  }
  for (const key of Object.keys(options)) {
    if (!OPTIONS.has(key)) {
      throw new TypeError(`Unsupported Sandbox option: ${key}`);
    }
  }
  for (const key of ['keepAlive', 'enableDefaultSession', 'normalizeId'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') {
      throw new TypeError(`Sandbox ${key} must be a boolean.`);
    }
  }
  if (
    options.sleepAfter !== undefined &&
    !(
      (typeof options.sleepAfter === 'number' &&
        Number.isFinite(options.sleepAfter) &&
        options.sleepAfter > 0) ||
      (typeof options.sleepAfter === 'string' && /^\d+(?:\.\d+)?[smh]$/.test(options.sleepAfter))
    )
  ) {
    throw new TypeError('Sandbox sleepAfter must be a positive duration.');
  }
  if (
    options.transport !== undefined &&
    !['http', 'websocket', 'rpc'].includes(options.transport)
  ) {
    throw new TypeError('Invalid Sandbox transport.');
  }
  if (options.containerTimeouts !== undefined) {
    const timeouts = options.containerTimeouts;
    if (!timeouts || typeof timeouts !== 'object' || Array.isArray(timeouts)) {
      throw new TypeError('Sandbox containerTimeouts must be an object.');
    }
    for (const [name, value] of Object.entries(timeouts)) {
      if (
        !['instanceGetTimeoutMS', 'portReadyTimeoutMS', 'waitIntervalMS'].includes(name) ||
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value <= 0 ||
        value > 300_000
      ) {
        throw new TypeError(`Invalid Sandbox container timeout: ${name}`);
      }
    }
  }
  if (
    options.labels !== undefined &&
    (!options.labels ||
      typeof options.labels !== 'object' ||
      Array.isArray(options.labels) ||
      Object.values(options.labels).some((value) => typeof value !== 'string'))
  ) {
    throw new TypeError('Sandbox labels must be strings.');
  }
}

function denied(reason: string): Error {
  // Workers RPC preserves Error messages, not arbitrary custom properties.
  // The SDK maps these stable prefixes back to the public error classes.
  return new Error(
    `VOID_SANDBOX_${reason === 'concurrency' || reason === 'runtime_budget' ? reason : 'unavailable'}`,
  );
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(denied('unavailable')), CONTROL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

class SandboxCapability extends RpcTarget {
  #sandbox: Sandbox;

  constructor(sandbox: Sandbox) {
    super();
    this.#sandbox = sandbox;
  }

  async invoke(operation: string, args: Array<unknown>): Promise<unknown> {
    if (!Array.isArray(args)) {
      throw new TypeError('Sandbox arguments must be an array.');
    }
    if (operation === 'tunnels') {
      const [method, ...parameters] = args;
      if (typeof method !== 'string' || !['get', 'list', 'destroy'].includes(method)) {
        throw new TypeError('Unsupported Sandbox tunnel operation.');
      }
      return this.#sandbox.callTunnels(method, parameters);
    }
    if (!OPERATIONS.has(operation)) {
      throw new TypeError(`Unsupported Sandbox operation: ${operation}`);
    }
    const optionName = {
      setSleepAfter: 'sleepAfter',
      setKeepAlive: 'keepAlive',
      setContainerTimeouts: 'containerTimeouts',
      setTransport: 'transport',
      setLabels: 'labels',
    }[operation];
    if (optionName) {
      validateOptions({ [optionName]: args[0] });
    }
    // Reuse the SDK's enhanced client for sessions, terminal connections, streams,
    // callbacks and Process methods. Its domain objects contain only application
    // operations; none contains a DurableObjectStub, namespace or lifecycle hook.
    const target = this.#sandbox as unknown as Record<
      string,
      (...values: Array<unknown>) => unknown
    >;
    const result = await target[operation]!(...prepareProcessCallbacks(args));
    if (operation === 'createSession' || operation === 'getSession') {
      return sessionWire(result as ExecutionSession);
    }
    return transferableResult(result);
  }
}

class ProcessCapability extends RpcTarget {
  #process: Process;

  constructor(process: Process) {
    super();
    this.#process = process;
  }

  async invoke(operation: string, args: Array<unknown>): Promise<unknown> {
    if (!Array.isArray(args)) {
      throw new TypeError('Process arguments must be an array.');
    }
    if (!PROCESS_OPERATIONS.has(operation)) {
      throw new TypeError(`Unsupported Sandbox process operation: ${operation}`);
    }
    const target = this.#process as unknown as Record<
      string,
      (...values: Array<unknown>) => unknown
    >;
    return target[operation]!(...args);
  }
}

class SessionCapability extends RpcTarget {
  #session: ExecutionSession;

  constructor(session: ExecutionSession) {
    super();
    this.#session = session;
  }

  async invoke(operation: string, args: Array<unknown>): Promise<unknown> {
    if (!Array.isArray(args)) {
      throw new TypeError('Session arguments must be an array.');
    }
    if (!SESSION_OPERATIONS.has(operation)) {
      throw new TypeError(`Unsupported Sandbox session operation: ${operation}`);
    }
    const target = this.#session as unknown as Record<
      string,
      (...values: Array<unknown>) => unknown
    >;
    return transferableResult(await target[operation]!(...prepareProcessCallbacks(args)));
  }
}

function prepareProcessCallbacks(args: Array<unknown>): Array<unknown> {
  const [command, options, ...rest] = args;
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return args;
  }
  const processOptions = options as ProcessOptions;
  if (typeof processOptions.onStart !== 'function') {
    return args;
  }
  return [
    command,
    {
      ...processOptions,
      onStart: (process: Process) => processOptions.onStart!(processWire(process) as never),
    },
    ...rest,
  ];
}

function processWire(process: Process): ProcessWire {
  return {
    __voidSandboxType: 'process',
    capability: new ProcessCapability(process),
    id: process.id,
    ...(process.pid === undefined ? {} : { pid: process.pid }),
    command: process.command,
    status: process.status,
    startTime: process.startTime,
    ...(process.endTime === undefined ? {} : { endTime: process.endTime }),
    ...(process.exitCode === undefined ? {} : { exitCode: process.exitCode }),
    ...(process.sessionId === undefined ? {} : { sessionId: process.sessionId }),
  };
}

function sessionWire(session: ExecutionSession): SessionWire {
  return {
    __voidSandboxType: 'session',
    capability: new SessionCapability(session),
    id: session.id,
  };
}

function transferableResult(result: unknown): unknown {
  if (isProcess(result)) {
    return processWire(result);
  }
  if (Array.isArray(result) && result.every(isProcess)) {
    return result.map(processWire);
  }
  return result;
}

export default class SandboxService extends WorkerEntrypoint<ControllerEnv> {
  async getSandbox(id: string, options: SandboxOptions = {}): Promise<SandboxCapability> {
    if (typeof id !== 'string' || id.length === 0 || id.length > 63) {
      throw new TypeError('Sandbox id must contain between 1 and 63 characters.');
    }
    validateOptions(options);
    const sandbox = getSandbox(this.env.SANDBOX, id, options);
    // Upstream getSandbox configures asynchronously. Await the same explicit
    // configuration before the service request ends so transport/session calls
    // cannot race a cancelled fire-and-forget setup request.
    await sandbox.configure({
      sandboxName: {
        name: options.normalizeId ? id.toLowerCase() : id,
        normalizeId: options.normalizeId,
      },
      sleepAfter: options.sleepAfter,
      keepAlive: options.keepAlive,
      containerTimeouts: options.containerTimeouts,
      transport: options.transport,
      labels: options.labels,
    });
    return new SandboxCapability(sandbox);
  }

  fetch(): Response {
    return new Response('Not found', { status: 404 });
  }
}

/** Platform-owned container lifecycle. No application module is loaded here. */
export class SandboxController extends Sandbox<ControllerEnv> {
  #starting: Promise<void> | undefined;
  #finishing: Promise<void> | undefined;

  async #arm(): Promise<void> {
    // Use the SDK scheduler: assigning the DO alarm directly loses its idle
    // timeout, and super.alarm can otherwise overwrite a metering alarm.
    this.deleteSchedules('voidHeartbeat');
    await this.schedule(HEARTBEAT_SECONDS, 'voidHeartbeat');
  }

  async #control(method: 'reserve' | 'started' | 'heartbeat', lease: Lease): Promise<void> {
    const result = await bounded(
      this.env.__VOID_SANDBOX_CONTROL[method](this.ctx.id.toString(), lease.generation),
    );
    if (!result.ok) {
      throw denied(result.reason);
    }
  }

  async #prepare(): Promise<void> {
    let lease = await this.ctx.storage.get<Lease>(LEASE_KEY);
    if (lease?.phase === 'running' && this.ctx.container?.running) {
      await this.#control('heartbeat', lease);
      return;
    }
    if (lease) {
      // A restart must settle the previous generation before claiming another.
      // A pending generation after eviction cannot prove successful startup.
      await this.#terminate();
    }
    lease = { generation: crypto.randomUUID(), phase: 'pending' };
    await this.ctx.storage.put(LEASE_KEY, lease);
    await this.#arm();
    await this.#control('reserve', lease);
  }

  #start(operation: () => Promise<void>): Promise<void> {
    if (this.#starting) {
      return this.#starting;
    }
    const pending = (async () => {
      try {
        await this.#prepare();
        await operation();
      } catch (error) {
        // Startup can fail after the process has booted but before its port is
        // ready. Kill it before relinquishing concurrency, even on gate failure.
        await this.#terminate().catch(() => {});
        throw error;
      }
    })();
    this.#starting = pending;
    void pending
      .finally(() => {
        if (this.#starting === pending) {
          this.#starting = undefined;
        }
      })
      .catch(() => {});
    return pending;
  }

  override start(...args: Parameters<Sandbox<ControllerEnv>['start']>): Promise<void> {
    return this.#start(() => super.start(...args));
  }

  override startAndWaitForPorts(
    ...args: Parameters<Sandbox<ControllerEnv>['startAndWaitForPorts']>
  ): Promise<void> {
    return this.#start(() => super.startAndWaitForPorts(...args));
  }

  override async onStart(): Promise<void> {
    const lease = await this.ctx.storage.get<Lease>(LEASE_KEY);
    if (!lease || lease.phase === 'stopped' || !this.ctx.container?.running) {
      throw denied('unavailable');
    }
    await this.#control('started', lease);
    await this.ctx.storage.put(LEASE_KEY, { ...lease, phase: 'running' } satisfies Lease);
    await this.#arm();
    await super.onStart();
  }

  async #finish(): Promise<void> {
    if (this.#finishing) {
      return this.#finishing;
    }
    const pending = (async () => {
      if (this.ctx.container?.running) {
        return;
      }
      const lease = await this.ctx.storage.get<Lease>(LEASE_KEY);
      if (!lease) {
        return;
      }
      await this.ctx.storage.put(LEASE_KEY, { ...lease, phase: 'stopped' } satisfies Lease);
      await this.#arm();
      await bounded(
        this.env.__VOID_SANDBOX_CONTROL.stopped(this.ctx.id.toString(), lease.generation),
      );
      await this.ctx.storage.delete(LEASE_KEY);
      this.deleteSchedules('voidHeartbeat');
    })();
    this.#finishing = pending;
    try {
      await pending;
    } finally {
      if (this.#finishing === pending) {
        this.#finishing = undefined;
      }
    }
  }

  async #terminate(): Promise<void> {
    // Sandbox.destroy performs application cleanup (including container commands)
    // before killing. Quota enforcement must not depend on that cleanup finishing.
    if (this.ctx.container?.running) {
      await this.ctx.container.destroy();
    }
    if (this.ctx.container?.running) {
      throw denied('unavailable');
    }
    await this.#finish();
  }

  override async onStop(...args: Parameters<Sandbox<ControllerEnv>['onStop']>): Promise<void> {
    // onActivityExpired only requests SIGTERM, and keepAlive may ignore it.
    // Only a confirmed stopped process releases capacity and finalizes usage.
    await this.#finish();
    await super.onStop(...args);
  }

  async voidHeartbeat(): Promise<void> {
    try {
      const lease = await this.ctx.storage.get<Lease>(LEASE_KEY);
      if (!lease) {
        return;
      }
      if (lease.phase === 'running' && this.ctx.container?.running) {
        await this.#control('heartbeat', lease);
      } else if (lease.phase !== 'pending' || !this.#starting) {
        await this.#terminate();
      }
    } catch (error) {
      await this.#terminate().catch(() => {});
      console.error('[void/sandbox] lifecycle check failed', error);
    } finally {
      if (await this.ctx.storage.get(LEASE_KEY)) {
        await this.#arm();
      }
    }
  }
}
