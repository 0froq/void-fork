import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HeaderRule } from "./cli/types";

/** Supported authentication providers. */
export type AuthProvider = "github" | "google" | "email";

/** Redirect destination — string (302) or object with explicit status. */
export type RedirectDestination = string | { to: string; status?: 301 | 302 | 307 | 308 };

/** Curated wrangler fields that can be set via void.json. */
export interface WranglerConfig {
  compatibility_date?: string;
  compatibility_flags?: string[];
}

/** Caching configuration. */
export interface CacheConfig {
  revalidate?: number | Record<string, number>;
  prerender?: string[];
}

/** Shape of the `void.json` config file. All fields optional. */
export interface VoidConfig {
  $schema?: string;
  auth?: boolean | AuthProvider[];
  bindings?: {
    db?: boolean | string;
    kv?: boolean | string;
    storage?: boolean | string;
    ai?: boolean;
  };
  build?: string;
  cache?: CacheConfig;
  scanDirs?: string[];
  headers?: Record<string, string[]>;
  redirects?: Record<string, RedirectDestination>;
  mode?: "spa" | "prebuilt" | "fullstack" | "framework";
  output?: "server" | "static";
  outputDir?: string;
  wrangler?: WranglerConfig;
}

const CONFIG_FILE = "void.json";

const VALID_AUTH_PROVIDERS = new Set(["github", "google", "email"]);
const VALID_MODES = new Set(["spa", "prebuilt", "fullstack", "framework"]);
const VALID_OUTPUTS = new Set(["server", "static"]);
const VALID_REDIRECT_STATUSES = new Set([301, 302, 307, 308]);

/**
 * Read and validate the `void.json` config file from the project root.
 * Returns an empty config object if no file exists.
 */
export function readConfig(root: string): VoidConfig {
  const filePath = join(root, CONFIG_FILE);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return {};
  }

  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${CONFIG_FILE}`);
  }

  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`${CONFIG_FILE} must be a JSON object`);
  }

  const obj = config as Record<string, unknown>;

  // Validate auth
  if (obj.auth !== undefined) {
    if (typeof obj.auth === "boolean") {
      // ok
    } else if (Array.isArray(obj.auth)) {
      for (const p of obj.auth) {
        if (typeof p !== "string" || !VALID_AUTH_PROVIDERS.has(p)) {
          throw new Error(`Invalid auth provider in ${CONFIG_FILE}: ${JSON.stringify(p)}`);
        }
      }
    } else {
      throw new Error(`"auth" in ${CONFIG_FILE} must be a boolean or an array of providers`);
    }
  }

  // Validate bindings
  if (obj.bindings !== undefined) {
    if (typeof obj.bindings !== "object" || obj.bindings === null || Array.isArray(obj.bindings)) {
      throw new Error(`"bindings" in ${CONFIG_FILE} must be an object`);
    }
    const b = obj.bindings as Record<string, unknown>;
    for (const key of Object.keys(b)) {
      if (!["db", "kv", "storage", "ai"].includes(key)) {
        throw new Error(`Unknown binding "${key}" in ${CONFIG_FILE}. Valid: db, kv, storage, ai`);
      }
      if (key === "ai") {
        if (typeof b[key] !== "boolean") {
          throw new Error(`"bindings.${key}" in ${CONFIG_FILE} must be a boolean`);
        }
      } else {
        if (typeof b[key] !== "boolean" && typeof b[key] !== "string") {
          throw new Error(
            `"bindings.${key}" in ${CONFIG_FILE} must be a boolean or a string (custom binding name)`,
          );
        }
      }
    }
  }

  // Validate build
  if (obj.build !== undefined && typeof obj.build !== "string") {
    throw new Error(`"build" in ${CONFIG_FILE} must be a string`);
  }

  // Validate scanDirs
  if (obj.scanDirs !== undefined) {
    if (!Array.isArray(obj.scanDirs) || !obj.scanDirs.every((d) => typeof d === "string")) {
      throw new Error(`"scanDirs" in ${CONFIG_FILE} must be an array of strings`);
    }
    for (const d of obj.scanDirs as string[]) {
      if (d.startsWith("/") || d.startsWith("..")) {
        throw new Error(`"scanDirs" path "${d}" in ${CONFIG_FILE} must be a relative directory`);
      }
    }
  }

  // Validate headers
  if (obj.headers !== undefined) {
    if (typeof obj.headers !== "object" || obj.headers === null || Array.isArray(obj.headers)) {
      throw new Error(`"headers" in ${CONFIG_FILE} must be an object`);
    }
    const h = obj.headers as Record<string, unknown>;
    for (const [pattern, values] of Object.entries(h)) {
      if (!pattern.startsWith("/")) {
        throw new Error(`Header pattern "${pattern}" in ${CONFIG_FILE} must start with "/"`);
      }
      if (!Array.isArray(values) || !values.every((v) => typeof v === "string")) {
        throw new Error(`Headers for "${pattern}" in ${CONFIG_FILE} must be an array of strings`);
      }
    }
  }

  // Validate redirects
  if (obj.redirects !== undefined) {
    if (
      typeof obj.redirects !== "object" ||
      obj.redirects === null ||
      Array.isArray(obj.redirects)
    ) {
      throw new Error(`"redirects" in ${CONFIG_FILE} must be an object`);
    }
    const r = obj.redirects as Record<string, unknown>;
    for (const [source, dest] of Object.entries(r)) {
      if (!source.startsWith("/")) {
        throw new Error(`Redirect source "${source}" in ${CONFIG_FILE} must start with "/"`);
      }
      if (typeof dest === "string") {
        // ok
      } else if (typeof dest === "object" && dest !== null && !Array.isArray(dest)) {
        const d = dest as Record<string, unknown>;
        if (typeof d.to !== "string") {
          throw new Error(`Redirect for "${source}" in ${CONFIG_FILE} must have a "to" string`);
        }
        if (d.status !== undefined && !VALID_REDIRECT_STATUSES.has(d.status as number)) {
          throw new Error(
            `Redirect status for "${source}" in ${CONFIG_FILE} must be 301, 302, 307, or 308`,
          );
        }
      } else {
        throw new Error(
          `Redirect for "${source}" in ${CONFIG_FILE} must be a string or an object with "to" and optional "status"`,
        );
      }
    }
  }

  // Validate mode
  if (obj.mode !== undefined) {
    if (typeof obj.mode !== "string" || !VALID_MODES.has(obj.mode)) {
      throw new Error(
        `"mode" in ${CONFIG_FILE} must be one of: spa, prebuilt, fullstack, framework`,
      );
    }
  }

  // Validate output
  if (obj.output !== undefined) {
    if (typeof obj.output !== "string" || !VALID_OUTPUTS.has(obj.output)) {
      throw new Error(`"output" in ${CONFIG_FILE} must be one of: server, static`);
    }
  }

  // Validate outputDir
  if (obj.outputDir !== undefined && typeof obj.outputDir !== "string") {
    throw new Error(`"outputDir" in ${CONFIG_FILE} must be a string`);
  }

  // Migration error for old top-level revalidate
  if (obj.revalidate !== undefined) {
    throw new Error(`"revalidate" has moved to "cache.revalidate" in ${CONFIG_FILE}`);
  }

  // Validate cache
  if (obj.cache !== undefined) {
    if (typeof obj.cache !== "object" || obj.cache === null || Array.isArray(obj.cache)) {
      throw new Error(`"cache" in ${CONFIG_FILE} must be an object`);
    }
    const cache = obj.cache as Record<string, unknown>;
    if (cache.revalidate !== undefined) {
      if (typeof cache.revalidate === "number") {
        if (!Number.isFinite(cache.revalidate) || cache.revalidate < 0) {
          throw new Error(
            `"cache.revalidate" in ${CONFIG_FILE} must be a non-negative finite number`,
          );
        }
      } else if (
        typeof cache.revalidate === "object" &&
        cache.revalidate !== null &&
        !Array.isArray(cache.revalidate)
      ) {
        const r = cache.revalidate as Record<string, unknown>;
        for (const [pattern, value] of Object.entries(r)) {
          if (pattern !== "*" && !pattern.startsWith("/")) {
            throw new Error(
              `"cache.revalidate" key "${pattern}" in ${CONFIG_FILE} must start with "/" or be "*"`,
            );
          }
          if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
            throw new Error(
              `"cache.revalidate" value for "${pattern}" in ${CONFIG_FILE} must be a non-negative finite number`,
            );
          }
        }
      } else {
        throw new Error(
          `"cache.revalidate" in ${CONFIG_FILE} must be a number or an object of path patterns to numbers`,
        );
      }
    }
    if (cache.prerender !== undefined) {
      if (!Array.isArray(cache.prerender) || !cache.prerender.every((p) => typeof p === "string")) {
        throw new Error(`"cache.prerender" in ${CONFIG_FILE} must be an array of strings`);
      }
      for (const p of cache.prerender as string[]) {
        if (!p.startsWith("/")) {
          throw new Error(`"cache.prerender" path "${p}" in ${CONFIG_FILE} must start with "/"`);
        }
      }
    }
  }

  // Validate wrangler
  if (obj.wrangler !== undefined) {
    if (typeof obj.wrangler !== "object" || obj.wrangler === null || Array.isArray(obj.wrangler)) {
      throw new Error(`"wrangler" in ${CONFIG_FILE} must be an object`);
    }
    const w = obj.wrangler as Record<string, unknown>;
    if (w.compatibility_date !== undefined) {
      if (typeof w.compatibility_date !== "string") {
        throw new Error(`"wrangler.compatibility_date" in ${CONFIG_FILE} must be a string`);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(w.compatibility_date)) {
        throw new Error(
          `"wrangler.compatibility_date" in ${CONFIG_FILE} must be YYYY-MM-DD format`,
        );
      }
    }
    if (w.compatibility_flags !== undefined) {
      if (
        !Array.isArray(w.compatibility_flags) ||
        !w.compatibility_flags.every((f) => typeof f === "string")
      ) {
        throw new Error(
          `"wrangler.compatibility_flags" in ${CONFIG_FILE} must be an array of strings`,
        );
      }
    }
  }

  return obj as VoidConfig;
}

/**
 * Extract custom binding names from config. Returns only entries where
 * a string name was explicitly provided (not `true`).
 */
export function resolveBindingNames(
  bindings: VoidConfig["bindings"],
): { d1?: string; kv?: string; r2?: string } | undefined {
  if (!bindings) return undefined;
  const names: { d1?: string; kv?: string; r2?: string } = {};
  let hasCustom = false;
  if (typeof bindings.db === "string") {
    names.d1 = bindings.db;
    hasCustom = true;
  }
  if (typeof bindings.kv === "string") {
    names.kv = bindings.kv;
    hasCustom = true;
  }
  if (typeof bindings.storage === "string") {
    names.r2 = bindings.storage;
    hasCustom = true;
  }
  return hasCustom ? names : undefined;
}

/**
 * Normalize the `auth` config field into a concrete provider list or null.
 */
export function normalizeAuth(auth: boolean | AuthProvider[] | undefined): AuthProvider[] | null {
  if (!auth) return null;
  if (auth === true) return ["email"];
  if (auth.length === 0) return null;
  return auth;
}

/**
 * Convert the `headers` config field into `HeaderRule[]` for the deploy manifest.
 *
 * Each key is a URL pattern (e.g. "/assets/*") and each value is an array of
 * "Name: value" strings. Returns undefined if the input is empty or undefined.
 */
export function convertHeadersConfig(
  headers: Record<string, string[]> | undefined,
): HeaderRule[] | undefined {
  if (!headers) return undefined;

  const rules: HeaderRule[] = [];

  for (const [pattern, values] of Object.entries(headers)) {
    const parsed: [string, string][] = [];
    for (const entry of values) {
      const colonIdx = entry.indexOf(":");
      if (colonIdx === -1) continue;
      const name = entry.slice(0, colonIdx).trim();
      const value = entry.slice(colonIdx + 1).trim();
      if (name) {
        parsed.push([name, value]);
      }
    }
    if (parsed.length > 0) {
      rules.push({ pattern, headers: parsed });
    }
  }

  return rules.length > 0 ? rules : undefined;
}

export interface RedirectRule {
  source: string;
  destination: string;
  status: number;
}

/**
 * Convert the `redirects` config field into `RedirectRule[]` for the deploy manifest.
 *
 * Each key is a URL pattern (e.g. "/old") and each value is either a string
 * destination (defaults to 302) or an object with `to` and optional `status`.
 * Returns undefined if the input is empty or undefined.
 */
export function convertRedirectsConfig(
  redirects: Record<string, RedirectDestination> | undefined,
): RedirectRule[] | undefined {
  if (!redirects) return undefined;

  const rules: RedirectRule[] = [];
  for (const [source, dest] of Object.entries(redirects)) {
    if (typeof dest === "string") {
      rules.push({ source, destination: dest, status: 302 });
    } else {
      rules.push({ source, destination: dest.to, status: dest.status ?? 302 });
    }
  }

  return rules.length > 0 ? rules : undefined;
}
