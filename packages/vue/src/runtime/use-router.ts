import { inject } from "vue";

export function useRouter() {
  const router = inject<any>("__vc_router", null);
  if (!router) {
    throw new Error("useRouter() must be called inside a Pages component");
  }
  return router as {
    visit(
      url: string,
      options?: { method?: string; data?: unknown; preserveScroll?: boolean },
    ): Promise<unknown>;
    reload(): Promise<unknown>;
    post(url: string, data?: unknown, options?: Record<string, unknown>): Promise<unknown>;
    put(url: string, data?: unknown, options?: Record<string, unknown>): Promise<unknown>;
    patch(url: string, data?: unknown, options?: Record<string, unknown>): Promise<unknown>;
    delete(url: string, options?: Record<string, unknown>): Promise<unknown>;
  };
}
