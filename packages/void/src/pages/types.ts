export interface PageDefinition {
  /** URL pattern, e.g. "/users/:id" */
  pattern: string;
  /** Route params, e.g. ["id"] */
  params: string[];
  /** Whether this is a catch-all route */
  catchAll: boolean;
  /** Component file relative path, e.g. "users/[id].vue" */
  componentPath: string;
  /** Server handler file relative path, e.g. "users/[id].server.ts" */
  serverPath: string | null;
  /** HTTP methods exported by server handler */
  methods: string[];
  /** Component ID used in page object, e.g. "users/[id]" */
  componentId: string;
  /** Edge caching revalidate TTL in seconds, from .server.ts export */
  revalidate?: number;
  /** Whether `export const prerender = true` is set in server handler */
  prerender?: boolean;
  /** Whether `export function getPrerenderPaths` is defined in server handler */
  hasGetPrerenderPaths?: boolean;
  /** Whether the island page has `with { island: ... }` imports */
  hasIslandImports?: boolean;
  /** Whether this is an island page (.island.tsx/.island.vue) */
  island?: boolean;
}

export interface LayoutDefinition {
  /** Directory path relative to pages/, e.g. "" (root) or "users" */
  directory: string;
  /** Layout file relative path, e.g. "layout.vue" or "users/layout.vue" */
  filePath: string;
  /** Whether this is an island layout (layout.island.tsx/.island.vue) */
  island?: boolean;
}

export interface PageScanResult {
  pages: PageDefinition[];
  layouts: LayoutDefinition[];
}
