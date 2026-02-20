export interface PageDefinition {
  /** URL pattern, e.g. "/users/:id" */
  pattern: string;
  /** Route params, e.g. ["id"] */
  params: string[];
  /** Whether this is a catch-all route */
  catchAll: boolean;
  /** Component file relative path, e.g. "users/[id].vue" */
  componentPath: string;
  /** Server handler file relative path, e.g. "users/[id].server.ts" or null for <script server> */
  serverPath: string | null;
  /** Whether the .vue file has a <script server> block (detected by regex) */
  hasInlineServer: boolean;
  /** HTTP methods exported by server handler */
  methods: string[];
  /** Component ID used in page object, e.g. "users/[id]" */
  componentId: string;
  /** Edge caching revalidate TTL in seconds, from .server.ts export */
  revalidate?: number;
}

export interface LayoutDefinition {
  /** Directory path relative to pages/, e.g. "" (root) or "users" */
  directory: string;
  /** Layout file relative path, e.g. "layout.vue" or "users/layout.vue" */
  filePath: string;
}

export interface PageScanResult {
  pages: PageDefinition[];
  layouts: LayoutDefinition[];
}
