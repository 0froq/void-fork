import { inject } from "vue";

export interface VoidRouter {
  onNavigation(onStart?: () => void, onEnd?: () => void): () => void;
  visit(
    url: string,
    options?: {
      method?: string;
      data?: unknown;
      preserveScroll?: boolean;
      preserveState?: boolean;
      viewTransition?: boolean;
    },
  ): Promise<unknown>;
  prefetch(
    url: string,
    options?: { method?: string; cacheFor?: number | string | [string, string] },
  ): void;
  flush(url: string, method?: string): void;
  flushAll(): void;
  reload(): Promise<unknown>;
  post(url: string, data?: unknown, options?: Record<string, unknown>): Promise<unknown>;
  put(url: string, data?: unknown, options?: Record<string, unknown>): Promise<unknown>;
  patch(url: string, data?: unknown, options?: Record<string, unknown>): Promise<unknown>;
  delete(url: string, options?: Record<string, unknown>): Promise<unknown>;
}

const ssrProxy: VoidRouter = new Proxy({} as VoidRouter, {
  get(_target, prop) {
    if (typeof prop === "symbol") return undefined;
    return () => {
      throw new Error(`router.${prop}() is not available during SSR`);
    };
  },
});

export function useRouter(): VoidRouter {
  return inject<any>("__void_router", null) ?? ssrProxy;
}
