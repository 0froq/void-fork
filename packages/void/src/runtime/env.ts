import { AsyncLocalStorage } from "node:async_hooks";

export type RuntimeEnv = Record<string, unknown>;

const envContext: AsyncLocalStorage<RuntimeEnv> = new AsyncLocalStorage<RuntimeEnv>();

let cloudflareEnv: RuntimeEnv | undefined;
try {
  const mod = (await import("cloudflare:workers")) as unknown as { env?: unknown };
  const maybeEnv = asEnv(mod.env);
  if (maybeEnv) {
    cloudflareEnv = maybeEnv;
  }
} catch {
  // Not running in workerd.
}

let getSvelteRequestEvent: (() => unknown) | undefined;
try {
  // Keep the specifier non-literal so bundling void doesn't require SvelteKit.
  const svelteKitSpecifier = "@sveltejs/kit/internal/server";
  const mod = (await import(svelteKitSpecifier)) as { getRequestEvent?: () => unknown };
  if (typeof mod.getRequestEvent === "function") {
    getSvelteRequestEvent = mod.getRequestEvent;
  }
} catch {
  // Not running in SvelteKit.
}

function asEnv(value: unknown): RuntimeEnv | null {
  if (typeof value !== "object" || value === null) return null;
  // Nuxt dev sets globalThis.__env__ to a Promise before resolving to env.
  if ("then" in value && typeof (value as { then?: unknown }).then === "function") return null;
  return value as RuntimeEnv;
}

function getVoidDevEnv(): RuntimeEnv | null {
  return asEnv((globalThis as RuntimeEnv & { __void_cf_env?: unknown }).__void_cf_env);
}

function getNuxtEnv(): RuntimeEnv | null {
  return asEnv((globalThis as RuntimeEnv & { __env__?: unknown }).__env__);
}

function getSvelteKitEnv(): RuntimeEnv | null {
  if (!getSvelteRequestEvent) return null;
  try {
    const event = getSvelteRequestEvent() as { platform?: { env?: unknown } } | undefined;
    return asEnv(event?.platform?.env);
  } catch {
    return null;
  }
}

export function withRuntimeEnv<T>(env: unknown, fn: () => T): T {
  const resolved = asEnv(env);
  if (!resolved) return fn();
  return envContext.run(resolved, fn);
}

export function getRuntimeEnv(): RuntimeEnv {
  return (
    envContext.getStore() ??
    getVoidDevEnv() ??
    getNuxtEnv() ??
    getSvelteKitEnv() ??
    cloudflareEnv ??
    (() => {
      throw new Error(
        "Cloudflare env is unavailable. Use void runtime bindings inside Nuxt/SvelteKit server request handlers or Worker handlers.",
      );
    })()
  );
}

export function getRuntimeBinding<T = unknown>(name: string): T | undefined {
  return getRuntimeEnv()[name] as T | undefined;
}

export function requireRuntimeBinding<T = unknown>(name: string): T {
  const value = getRuntimeBinding<T>(name);
  if (value !== undefined && value !== null) return value;
  throw new Error(`Missing Cloudflare binding "${name}".`);
}
