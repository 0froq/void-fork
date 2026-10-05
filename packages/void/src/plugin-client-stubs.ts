import { type Plugin } from 'vite';

export function createClientStubsPlugin(): Plugin {
  const STUB_PREFIX = '\0void-client-stub:';
  const SERVER_ONLY_STUBS: Record<string, string> = {
    'void/db': 'export const db = {}; export const createDb = () => ({});',
    'void/kv': 'export const kv = {}; export const createKV = () => ({});',
    'void/ai': 'export const ai = {};',
    'void/queues': 'export const queues = {};',
    'void/storage': 'export const storage = {}; export const createStorage = () => ({});',
    'void/isr': 'export const revalidate = async () => {};',
    // Client stub must mirror the real runtime/sandbox.ts surface so any
    // client-side `instanceof` check for either runtime error doesn't crash with a
    // TypeError, and async `await getSandbox(...)` callers don't silently
    // mis-handle a sync return. Throwing here makes accidental client imports
    // fail loudly rather than returning a misleading bare `{}`.
    'void/sandbox': `
      export class SandboxLimitError extends Error {
        constructor(reason = 'concurrency', message) {
          super(message ?? 'Sandbox limit reached: ' + reason);
          this.name = 'SandboxLimitError';
          this.reason = reason;
        }
      }
      export class SandboxUnavailableError extends Error {
        constructor(message = 'Managed Sandbox is unavailable on this Void platform.') {
          super(message);
          this.name = 'SandboxUnavailableError';
        }
      }
      export async function getSandbox() {
        throw new Error('void/sandbox is server-only and cannot be imported by browser code.');
      }
      export const sandbox = { get: getSandbox };
    `,
    // Server-only for the same reason as the rest: `void/email` reaches
    // `runtime/env-raw.ts`, whose top-level `node:async_hooks` import and
    // module-scope `new AsyncLocalStorage()` have no browser equivalent.
    // Without a stub the client build SUCCEEDS with only an externalization
    // warning and ships `new (emptyStub).AsyncLocalStorage` — the page then
    // white-screens on load, which is worse than a build failure.
    // `void/email/testing` needs its own entry (the filter is anchored) for
    // a different reason: it pulls `router/email.ts`, dragging node:path,
    // node:fs and node:module plus ~24 KB of build-time router machinery
    // into the browser bundle.
    //
    // Throwing rather than returning `{}`, following `void/sandbox`: an
    // accidental client import should fail legibly instead of silently
    // no-oping a send the caller believes happened.
    'void/email': `
      const serverOnly = (name) => () => {
        throw new Error(name + ' is server-only and cannot be imported by browser code.');
      };
      export const sendEmail = serverOnly('sendEmail');
      export const createEmail = serverOnly('createEmail');
      export const defineEmail = serverOnly('defineEmail');
      export const parseEmail = serverOnly('parseEmail');
      export const replyEmail = serverOnly('replyEmail');
      export const createMessageProxy = serverOnly('createMessageProxy');
    `,
    'void/email/testing': `
      const serverOnly = (name) => () => {
        throw new Error(name + ' is server-only and cannot be imported by browser code.');
      };
      export const createEmailTestHarness = serverOnly('createEmailTestHarness');
      export const createInboundTestHarness = serverOnly('createInboundTestHarness');
    `,
    'void/live': '',
    'void/durable': '',
  };
  const STUB_RESOLVE_FILTER = new RegExp(
    `^(${Object.keys(SERVER_ONLY_STUBS).join('|').replaceAll('/', '\\/')})$`,
  );
  // eslint-disable-next-line no-control-regex -- Vite virtual module null-byte prefix
  const STUB_LOAD_FILTER = new RegExp(`^\\0void-client-stub:`);

  const clientStubsPlugin: Plugin = {
    name: 'void:client-stubs',
    enforce: 'pre',
    resolveId: {
      filter: { id: STUB_RESOLVE_FILTER },
      handler(id) {
        if (this.environment?.name === 'client') {
          if (id === 'void/live' || id === 'void/durable') {
            this.error(
              id === 'void/live'
                ? 'void/live is server-only and cannot be imported by browser code. Import void/live/client instead.'
                : 'void/durable is server-only and cannot be imported by browser code.',
            );
          }
          return STUB_PREFIX + id;
        }
      },
    },
    load: {
      filter: { id: STUB_LOAD_FILTER },
      handler(id) {
        return SERVER_ONLY_STUBS[id.slice(STUB_PREFIX.length)] ?? 'export default {};';
      },
    },
  };

  return clientStubsPlugin;
}
