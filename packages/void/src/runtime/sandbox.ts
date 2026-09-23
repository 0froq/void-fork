import {
  Sandbox,
  getSandbox as getCloudflareSandbox,
  type ExecutionSession,
  type Process,
  type SandboxOptions,
} from '@cloudflare/sandbox';
import { getRawRuntimeEnv } from './env-raw.ts';
import { requireRuntimeBinding } from './env.ts';

export { Sandbox };
export type { SandboxOptions };

export const DEFAULT_SANDBOX_ID = 'default';
export const DEFAULT_SANDBOX_BINDING = 'SANDBOX';
export const SANDBOX_SERVICE_BINDING = '__VOID_SANDBOX';
export type VoidSandboxOptions = SandboxOptions & { binding?: string };

export class SandboxLimitError extends Error {
  override readonly name = 'SandboxLimitError';
  readonly reason: 'concurrency' | 'runtime_budget';

  constructor(reason: 'concurrency' | 'runtime_budget', message?: string) {
    super(message ?? `Sandbox limit reached: ${reason}`);
    this.reason = reason;
  }
}

export class SandboxUnavailableError extends Error {
  override readonly name = 'SandboxUnavailableError';

  constructor(message = 'Managed Sandbox is unavailable on this Void platform.') {
    super(message);
  }
}

type SandboxCapability = {
  invoke(operation: string, args: Array<unknown>): Promise<unknown>;
};
type NestedCapability = {
  invoke(operation: string, args: Array<unknown>): Promise<unknown>;
};
type ProcessWire = Omit<
  Process,
  'kill' | 'getStatus' | 'getLogs' | 'waitForLog' | 'waitForPort' | 'waitForExit'
> & {
  __voidSandboxType: 'process';
  capability: NestedCapability;
};
type SessionWire = {
  __voidSandboxType: 'session';
  capability: NestedCapability;
  id: string;
};
type SandboxService = {
  getSandbox(id: string, options: SandboxOptions): Promise<SandboxCapability>;
};

let sandboxBindingName = DEFAULT_SANDBOX_BINDING;

export function __setSandboxBindingName(bindingName: string): void {
  sandboxBindingName = bindingName;
}

function rethrowSandboxError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  for (const reason of ['concurrency', 'runtime_budget'] as const) {
    if (message.includes(`VOID_SANDBOX_${reason}`)) {
      throw new SandboxLimitError(reason);
    }
  }
  if (message.includes('VOID_SANDBOX_unavailable')) {
    throw new SandboxUnavailableError();
  }
  throw error;
}

function managedClient<T extends Sandbox>(capability: SandboxCapability): T {
  const call = async (
    target: NestedCapability,
    operation: string,
    args: Array<unknown>,
  ): Promise<unknown> => {
    try {
      return decodeManagedResult(
        await target.invoke(operation, prepareManagedArgs(operation, args)),
      );
    } catch (error) {
      rethrowSandboxError(error);
    }
  };
  // The server owns the operation allowlist. The Proxy preserves the upstream
  // SDK's method-shaped API without serializing streams, callback functions or
  // session/process objects through JSON. It never contains a raw DO stub.
  return new Proxy(Object.create(null) as T, {
    get(_target, property) {
      if (typeof property !== 'string' || property === 'then') {
        return undefined;
      }
      if (property === 'tunnels') {
        return new Proxy(Object.create(null) as object, {
          get(_tunnels, method) {
            if (typeof method !== 'string' || method === 'then') {
              return undefined;
            }
            return (...args: Array<unknown>) => call(capability, 'tunnels', [method, ...args]);
          },
        });
      }
      return (...args: Array<unknown>) => call(capability, property, args);
    },
  });

  function decodeManagedResult(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map(decodeManagedResult);
    }
    if (!value || typeof value !== 'object') {
      return value;
    }
    const record = value as Record<string, unknown>;
    if (record.__voidSandboxType === 'process') {
      const {
        capability: processCapability,
        __voidSandboxType: _type,
        ...snapshot
      } = value as ProcessWire;
      return Object.assign(snapshot, {
        kill: (...args: Array<unknown>) => call(processCapability, 'kill', args),
        getStatus: (...args: Array<unknown>) => call(processCapability, 'getStatus', args),
        getLogs: (...args: Array<unknown>) => call(processCapability, 'getLogs', args),
        waitForLog: (...args: Array<unknown>) => call(processCapability, 'waitForLog', args),
        waitForPort: (...args: Array<unknown>) => call(processCapability, 'waitForPort', args),
        waitForExit: (...args: Array<unknown>) => call(processCapability, 'waitForExit', args),
      } as unknown as Pick<
        Process,
        'kill' | 'getStatus' | 'getLogs' | 'waitForLog' | 'waitForPort' | 'waitForExit'
      >);
    }
    if (record.__voidSandboxType === 'session') {
      const session = value as SessionWire;
      return new Proxy({ id: session.id } as ExecutionSession, {
        get(target, property) {
          if (property === 'id') {
            return target.id;
          }
          if (typeof property !== 'string' || property === 'then') {
            return undefined;
          }
          return (...args: Array<unknown>) => call(session.capability, property, args);
        },
      });
    }
    return value;
  }

  function prepareManagedArgs(operation: string, args: Array<unknown>): Array<unknown> {
    if (operation !== 'startProcess') {
      return args;
    }
    const [command, options, ...rest] = args;
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      return args;
    }
    const onStart = (options as { onStart?: unknown }).onStart;
    if (typeof onStart !== 'function') {
      return args;
    }
    return [
      command,
      {
        ...options,
        onStart: (process: unknown) => onStart(decodeManagedResult(process)),
      },
      ...rest,
    ];
  }
}

/**
 * Retained for generated native/local Worker entries. Managed deployments host
 * the platform-owned Sandbox class in a separate Worker and never use this DO.
 */
export class VoidPlatformSandbox<Env = unknown> extends Sandbox<Env> {
  override async onStart(): Promise<void> {
    const env = this.env as Record<string, unknown>;
    if (env.__PROJECT_ID !== undefined || env.__VOID_PROXY !== undefined) {
      throw new SandboxUnavailableError(
        'Managed Sandboxes require the platform Sandbox controller. Redeploy this application.',
      );
    }
    await super.onStart();
  }
}

/** Resolve an isolated Sandbox on the current deployment. Starts on first use. */
export async function getSandbox<T extends Sandbox = Sandbox>(
  id: string = DEFAULT_SANDBOX_ID,
  options?: VoidSandboxOptions,
): Promise<T> {
  const { binding = sandboxBindingName, ...sandboxOptions } = options ?? {};
  const runtimeEnv = getRawRuntimeEnv();
  const service = runtimeEnv[SANDBOX_SERVICE_BINDING] as SandboxService | undefined;
  if (service) {
    if (binding !== sandboxBindingName) {
      throw new SandboxUnavailableError(`Managed Sandbox binding ${binding} is unavailable.`);
    }
    try {
      return managedClient<T>(
        await service.getSandbox(id, { normalizeId: true, ...sandboxOptions }),
      );
    } catch (error) {
      rethrowSandboxError(error);
    }
  }
  if (runtimeEnv.__PROJECT_ID !== undefined || runtimeEnv.__VOID_PROXY !== undefined) {
    throw new SandboxUnavailableError(
      'This deployment has no managed Sandbox controller. Redeploy this application.',
    );
  }
  return getCloudflareSandbox<T>(requireRuntimeBinding<DurableObjectNamespace<T>>(binding), id, {
    normalizeId: true,
    ...sandboxOptions,
  });
}

export const sandbox: { get: typeof getSandbox } = { get: getSandbox };
