/// <reference lib="dom" />

import { PrefetchCache, parseCacheFor } from "./prefetch";
import type { CacheForResult, CacheForInput } from "./prefetch";
import { initClientHead, applyClientHead } from "./head-client";

// --- Types ---

export interface VisitOptions {
  method?: string;
  data?: unknown;
  preserveScroll?: boolean;
  preserveState?: boolean;
  viewTransition?: boolean;
}

export interface PrefetchOptions {
  method?: string;
  cacheFor?: CacheForInput;
}

export interface VoidRouter {
  _hoverDelay: number;
  onNavigation(onStart?: () => void, onEnd?: () => void): () => void;
  visit(url: string, options?: VisitOptions): Promise<any>;
  prefetch(url: string, options?: PrefetchOptions): void;
  flush(url: string, method?: string): void;
  flushAll(): void;
  reload(): Promise<any>;
  post(url: string, data?: unknown, options?: VisitOptions): Promise<any>;
  put(url: string, data?: unknown, options?: VisitOptions): Promise<any>;
  patch(url: string, data?: unknown, options?: VisitOptions): Promise<any>;
  delete(url: string, options?: VisitOptions): Promise<any>;
}

export interface PageRouterAdapter {
  createDeferred(): unknown;
  resolveDeferred(ref: unknown, value: unknown): unknown;
  rejectDeferred(ref: unknown, error: string): unknown;
  isLoading(ref: unknown): boolean;
  applyUpdate(pageData: any, component: any, layouts: any[]): void | Promise<void>;
  onDeferredUpdate?(props: Record<string, unknown>): void;
}

export interface PageRouterConfig {
  adapter: PageRouterAdapter;
  components: Record<string, () => Promise<{ default: any }>>;
  layoutTree: Record<string, string[]>;
  routeMeta: Record<string, { island?: boolean }>;
  matchRoute(url: string): string | null;
  viewTransitions: boolean;
  prefetchHoverDelay: number;
  prefetchDefaultCacheFor: CacheForResult;
}

// --- Form utilities ---

export function isFile(value: unknown): boolean {
  return (
    (typeof File !== "undefined" && value instanceof File) ||
    value instanceof Blob ||
    (typeof FileList !== "undefined" && value instanceof FileList && value.length > 0)
  );
}

export function hasFiles(data: unknown): boolean {
  return (
    isFile(data) ||
    (typeof data === "object" && data !== null && Object.values(data).some(hasFiles))
  );
}

export function objectToFormData(
  source: Record<string, unknown>,
  form?: FormData,
  parentKey?: string,
): FormData {
  form = form || new FormData();
  for (const key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const composed = parentKey ? parentKey + "[" + key + "]" : key;
    const value = source[key] as any;
    if (value instanceof File) form.append(composed, value, value.name);
    else if (value instanceof Blob) form.append(composed, value);
    else if (typeof FileList !== "undefined" && value instanceof FileList) {
      for (let i = 0; i < value.length; i++) form.append(composed + "[]", value[i], value[i].name);
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) objectToFormData({ [i]: value[i] }, form, composed);
    } else if (value instanceof Date) form.append(composed, value.toISOString());
    else if (typeof value === "boolean") form.append(composed, value ? "1" : "0");
    else if (typeof value === "string") form.append(composed, value);
    else if (typeof value === "number") form.append(composed, String(value));
    else if (value === null || value === undefined) form.append(composed, "");
    else objectToFormData(value, form, composed);
  }
  return form;
}

// --- SSR proxy ---

export const ssrProxy: VoidRouter = new Proxy({} as VoidRouter, {
  get(_target, prop) {
    if (typeof prop === "symbol") return undefined;
    return () => {
      throw new Error(`router.${prop}() is not available during SSR`);
    };
  },
});

// --- createPageRouter factory ---

export async function createPageRouter(config: PageRouterConfig): Promise<{
  router: VoidRouter;
  initialPageData: any;
  initialComponent: any;
  initialLayouts: any[];
  start(): void;
}> {
  const {
    adapter,
    components,
    layoutTree,
    routeMeta,
    matchRoute,
    viewTransitions: VIEW_TRANSITIONS_ENABLED,
    prefetchHoverDelay: PREFETCH_HOVER_DELAY,
    prefetchDefaultCacheFor: PREFETCH_DEFAULT_CACHE_FOR,
  } = config;

  const _prefetchCache = new PrefetchCache();

  async function resolveComponent(id: string) {
    const loader = components[id];
    if (!loader) throw new Error("Unknown page component: " + id);
    return (await loader()).default;
  }

  async function resolveLayouts(componentId: string) {
    const ids = layoutTree[componentId] || [];
    return Promise.all(ids.map(async (id: string) => (await components[id]()).default));
  }

  // --- Deferred props ---

  let activeKeyRefs: Record<string, unknown> = {};
  let currentPropsObj: Record<string, unknown> = {};
  let _abortController: AbortController | null = null;

  function setupDeferredProps(pageData: any): Record<string, unknown> {
    const keyRefs: Record<string, unknown> = {};
    if (!pageData.deferredKeys) return keyRefs;
    for (const key of Object.keys(pageData.deferredKeys)) {
      const ref = adapter.createDeferred();
      keyRefs[key] = ref;
      pageData.props[key] = ref;
    }
    return keyRefs;
  }

  function handleDeferredMessage(group: string, data: unknown, error: unknown): void {
    if (data !== undefined) {
      if (typeof data === "object" && data !== null && !Array.isArray(data)) {
        let resolvedAny = false;
        for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
          if (activeKeyRefs[key]) {
            const updated = adapter.resolveDeferred(activeKeyRefs[key], value);
            activeKeyRefs[key] = updated;
            currentPropsObj[key] = updated;
            resolvedAny = true;
          }
        }
        if (!resolvedAny && activeKeyRefs[group]) {
          const updated = adapter.resolveDeferred(activeKeyRefs[group], data);
          activeKeyRefs[group] = updated;
          currentPropsObj[group] = updated;
        }
      } else {
        if (activeKeyRefs[group]) {
          const updated = adapter.resolveDeferred(activeKeyRefs[group], data);
          activeKeyRefs[group] = updated;
          currentPropsObj[group] = updated;
        }
      }
    } else if (error !== undefined) {
      const errStr = typeof error === "string" ? error : String(error);
      for (const [key, ref] of Object.entries(activeKeyRefs)) {
        if (adapter.isLoading(ref)) {
          const updated = adapter.rejectDeferred(ref, errStr);
          activeKeyRefs[key] = updated;
          currentPropsObj[key] = updated;
        }
      }
    }
    adapter.onDeferredUpdate?.(currentPropsObj);
  }

  // SSR deferred resolution via streamed script tags
  (window as any).__resolveDeferred = (group: string, data: unknown) =>
    handleDeferredMessage(group, data, undefined);
  (window as any).__rejectDeferred = (group: string, error: unknown) =>
    handleDeferredMessage(group, undefined, error);

  // --- Navigation listeners ---

  const _navListeners = new Set<{ onStart?: () => void; onEnd?: () => void }>();

  // --- Router ---

  const router: VoidRouter = {
    _hoverDelay: PREFETCH_HOVER_DELAY,

    onNavigation(onStart, onEnd) {
      const entry = { onStart, onEnd };
      _navListeners.add(entry);
      return () => {
        _navListeners.delete(entry);
      };
    },

    async visit(url, options = {}) {
      for (const l of _navListeners) l.onStart?.();
      try {
        _abortController?.abort();
        _abortController = new AbortController();

        const method = (options.method || "GET").toUpperCase();

        if (method !== "GET") {
          _prefetchCache.flushAll();
        }

        const headers: Record<string, string> = {
          "X-VoidPages": "true",
          Accept: "application/json",
        };
        const fetchOptions: any = { method, headers, signal: _abortController.signal };

        if (options.data && method !== "GET") {
          if (hasFiles(options.data)) {
            fetchOptions.body = objectToFormData(options.data as Record<string, unknown>);
          } else {
            headers["Content-Type"] = "application/json";
            fetchOptions.body = JSON.stringify(options.data);
          }
        }

        let pageData: any;
        const cacheEntry = method === "GET" ? _prefetchCache.get(url, method) : null;

        if (cacheEntry) {
          pageData = await cacheEntry.response;
          _prefetchCache.consume(url, method);
          if (pageData === null) {
            window.location.href = url;
            return;
          }
          // Prefetch responses have deferred props pre-resolved — wrap them
          if (pageData.deferredKeys) {
            for (const key of Object.keys(pageData.deferredKeys)) {
              const value = pageData.props[key];
              const ref = adapter.createDeferred();
              pageData.props[key] = adapter.resolveDeferred(ref, value);
            }
          }
          // If stale, fire background refetch to refresh cache
          if (!_prefetchCache.isFresh(cacheEntry)) {
            const bgHeaders = {
              "X-VoidPages": "true",
              Accept: "application/json",
              Purpose: "prefetch",
            };
            const bgFetch = fetch(url, { method, headers: bgHeaders }).then((r) => {
              if (!r.headers.get("X-VoidPages")) return null;
              return r.json();
            });
            _prefetchCache.set(url, method, bgFetch, PREFETCH_DEFAULT_CACHE_FOR);
          }
        } else {
          const response = await fetch(url, fetchOptions);

          if (response.redirected) {
            return router.visit(response.url);
          }

          if (!response.headers.get("X-VoidPages")) {
            window.location.href = url;
            return;
          }

          const contentType = response.headers.get("content-type") || "";

          if (contentType.includes("application/x-ndjson")) {
            const reader = response.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let firstLine = true;
            const signal = _abortController.signal;

            const processLines = () => {
              let newlineIdx;
              while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, newlineIdx);
                buffer = buffer.slice(newlineIdx + 1);
                if (!line) continue;

                if (firstLine) {
                  pageData = JSON.parse(line);
                  activeKeyRefs = setupDeferredProps(pageData);
                  currentPropsObj = pageData.props;
                  firstLine = false;
                } else {
                  const msg = JSON.parse(line);
                  if (msg.__deferred) {
                    handleDeferredMessage(msg.__deferred, msg.data, msg.error);
                  }
                }
              }
            };

            // Read first line to get pageData for mounting
            while (firstLine) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              processLines();
            }

            // Continue reading deferred data in background
            (async () => {
              try {
                while (!signal.aborted) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  buffer += decoder.decode(value, { stream: true });
                  processLines();
                }
                if (buffer.trim()) processLines();
              } catch (e: any) {
                if (e.name !== "AbortError") {
                  for (const [key, ref] of Object.entries(activeKeyRefs)) {
                    if (adapter.isLoading(ref)) {
                      const updated = adapter.rejectDeferred(
                        ref,
                        "Stream closed before resolution",
                      );
                      activeKeyRefs[key] = updated;
                      currentPropsObj[key] = updated;
                    }
                  }
                  adapter.onDeferredUpdate?.(currentPropsObj);
                }
              }
            })();
          } else {
            pageData = await response.json();
          }
        }

        // Resolve async work before starting the transition
        const [comp, layouts] = await Promise.all([
          resolveComponent(pageData.component),
          resolveLayouts(pageData.component),
        ]);

        const useTransition = options.viewTransition ?? VIEW_TRANSITIONS_ENABLED;
        if (useTransition && document.startViewTransition) {
          document.startViewTransition(() => adapter.applyUpdate(pageData, comp, layouts));
        } else {
          adapter.applyUpdate(pageData, comp, layouts);
        }

        applyClientHead(pageData.head);

        if (!options.preserveState) {
          window.history.pushState({}, "", pageData.url);
        }

        if (!options.preserveScroll) {
          window.scrollTo(0, 0);
        }

        return pageData;
      } finally {
        for (const l of _navListeners) l.onEnd?.();
      }
    },

    prefetch(url, options = {}) {
      const id = matchRoute(url);
      if (!id) return;

      if (routeMeta[id]?.island) {
        if (!document.querySelector('link[rel="prefetch"][href="' + url + '"]')) {
          const link = document.createElement("link");
          link.rel = "prefetch";
          link.href = url;
          link.as = "document";
          document.head.appendChild(link);
        }
        return;
      }

      if (components[id]) components[id]();
      const layoutIds = layoutTree[id] || [];
      for (const lid of layoutIds) {
        if (components[lid]) components[lid]();
      }

      const method = (options.method || "GET").toUpperCase();
      if (_prefetchCache.has(url, method)) return;
      const ttl = options.cacheFor ? parseCacheFor(options.cacheFor) : PREFETCH_DEFAULT_CACHE_FOR;
      const headers = {
        "X-VoidPages": "true",
        Accept: "application/json",
        Purpose: "prefetch",
      };
      const fetchPromise = fetch(url, { method, headers }).then((r) => {
        if (!r.headers.get("X-VoidPages")) return null;
        return r.json();
      });
      _prefetchCache.set(url, method, fetchPromise, ttl);
    },

    flush(url, method = "GET") {
      _prefetchCache.flush(url, method);
    },

    flushAll() {
      _prefetchCache.flushAll();
    },

    async reload() {
      return router.visit(window.location.pathname + window.location.search, {
        preserveState: true,
        preserveScroll: true,
      });
    },

    post(url, data, options = {}) {
      return router.visit(url, { ...options, method: "POST", data });
    },
    put(url, data, options = {}) {
      return router.visit(url, { ...options, method: "PUT", data });
    },
    patch(url, data, options = {}) {
      return router.visit(url, { ...options, method: "PATCH", data });
    },
    delete(url, options = {}) {
      return router.visit(url, { ...options, method: "DELETE" });
    },
  };

  // --- Initialization ---

  const appEl = document.getElementById("app")!;
  const initialPageData = JSON.parse(appEl.getAttribute("data-page")!);

  const [initialComponent, initialLayouts] = await Promise.all([
    resolveComponent(initialPageData.component),
    resolveLayouts(initialPageData.component),
  ]);

  activeKeyRefs = setupDeferredProps(initialPageData);
  currentPropsObj = initialPageData.props;

  function start(): void {
    initClientHead(initialPageData.head);

    // Drain any deferred resolutions that arrived before the module loaded
    if ((window as any).__deferredQueue) {
      for (const entry of (window as any).__deferredQueue) {
        if (entry.length === 3) handleDeferredMessage(entry[0], undefined, entry[2]);
        else handleDeferredMessage(entry[0], entry[1], undefined);
      }
      delete (window as any).__deferredQueue;
    }

    window.addEventListener("popstate", () => {
      router.visit(window.location.pathname + window.location.search, {
        preserveState: true,
      });
    });
  }

  return { router, initialPageData, initialComponent, initialLayouts, start };
}

// --- Island hydration ---

export function scheduleHydration(
  el: Element,
  loader: () => Promise<unknown>,
  props: Record<string, unknown>,
  strategy: string,
  hydrateFn: (el: Element, mod: unknown, props: Record<string, unknown>) => void | Promise<void>,
): void {
  const hydrate = () => loader().then((mod) => hydrateFn(el, mod, props));

  if (strategy === "load") {
    hydrate();
  } else if (strategy === "visible") {
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        observer.disconnect();
        hydrate();
      }
    });
    observer.observe(el);
  } else if (strategy === "idle") {
    const schedule = (window as any).requestIdleCallback || ((cb: () => void) => setTimeout(cb, 1));
    schedule(() => hydrate());
  } else if (strategy.startsWith("media:")) {
    const query = strategy.slice(6);
    const mql = matchMedia(query);
    const check = () => {
      if (mql.matches) {
        mql.removeEventListener("change", check);
        hydrate();
      }
    };
    mql.addEventListener("change", check);
    check();
  }
}

export function initIslands(
  islands: Record<string, () => Promise<unknown>>,
  hydrateFn: (el: Element, mod: unknown, props: Record<string, unknown>) => void | Promise<void>,
): void {
  document.querySelectorAll("[data-island]").forEach((el) => {
    const id = el.getAttribute("data-island")!;
    const props = JSON.parse(el.getAttribute("data-props") || "{}");
    const strategy = el.getAttribute("data-hydrate") || "load";
    const loader = islands[id];
    if (loader) scheduleHydration(el, loader, props, strategy, hydrateFn);
  });
}
