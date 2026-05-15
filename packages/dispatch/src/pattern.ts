/**
 * Shared path-pattern compiler used by header rules and routing rules.
 *
 * Syntax:
 *   `:name`   — single path segment, captured as `name`
 *   `:name*`  — zero or more path segments, captured as `name`
 *   `*`       — zero or more path segments, captured as `splat` (legacy)
 *
 * When a legacy pattern contains multiple anonymous `*`, the first captures
 * as `splat` and later wildcards are non-capturing. Boolean matching remains
 * backward compatible for existing header/revalidate patterns.
 */

const MAX_CACHE = 256;

export type CompiledPattern = {
  regex: RegExp;
  paramNames: Array<string>;
};

const compileCache = new Map<string, CompiledPattern>();

const REGEX_SPECIAL = /[.+?^${}()|[\]\\]/;
const PARAM_CHAR = /[A-Za-z0-9_]/;

export function compilePattern(source: string): CompiledPattern {
  const cached = compileCache.get(source);
  if (cached) {
    // LRU touch: re-inserting moves the entry to the most-recently-used end
    // of Map iteration order, so eviction below removes the true LRU.
    compileCache.delete(source);
    compileCache.set(source, cached);
    return cached;
  }

  const paramNames: Array<string> = [];
  let legacySplatCaptured = false;
  let pattern = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ':') {
      let j = i + 1;
      while (j < source.length && PARAM_CHAR.test(source[j]!)) {
        j++;
      }
      const name = source.slice(i + 1, j);
      if (!name) {
        pattern += '\\:';
        i++;
        continue;
      }
      if (source[j] === '*') {
        paramNames.push(name);
        pattern += `(?<${name}>.*)`;
        i = j + 1;
      } else {
        paramNames.push(name);
        pattern += `(?<${name}>[^/]+)`;
        i = j;
      }
    } else if (ch === '*') {
      if (legacySplatCaptured) {
        pattern += `.*`;
      } else {
        paramNames.push('splat');
        pattern += `(?<splat>.*)`;
        legacySplatCaptured = true;
      }
      i++;
    } else {
      if (REGEX_SPECIAL.test(ch)) {
        pattern += '\\';
      }
      pattern += ch;
      i++;
    }
  }

  const compiled: CompiledPattern = { regex: new RegExp(`^${pattern}$`), paramNames };
  if (compileCache.size >= MAX_CACHE) {
    const first = compileCache.keys().next();
    if (!first.done) {
      compileCache.delete(first.value);
    }
  }
  compileCache.set(source, compiled);
  return compiled;
}

/**
 * Match a pattern against a pathname. Returns captured params, or null.
 *
 * Returns null (rather than throwing) when the pattern itself is malformed —
 * e.g. multiple `*` producing duplicate `splat` capture names. Framework and
 * API ingest both reject those, but a hand-crafted manifest could still reach
 * the edge, and a single bad rule shouldn't 500 unrelated traffic.
 */
export function matchPatternCaptures(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  let compiled: CompiledPattern;
  try {
    compiled = compilePattern(pattern);
  } catch {
    return null;
  }
  const m = compiled.regex.exec(pathname);
  if (!m) {
    return null;
  }
  return m.groups ?? {};
}

/**
 * Match a pattern against a pathname (boolean form). Header-rule callers only
 * need a yes/no — they don't care about captures. Malformed patterns yield
 * `false` rather than throwing (see `matchPatternCaptures`).
 */
export function matchPattern(pattern: string, pathname: string): boolean {
  try {
    return compilePattern(pattern).regex.test(pathname);
  } catch {
    return false;
  }
}

const literalRegexCache = new Map<string, RegExp>();

/**
 * Match a pattern against a pathname using LITERAL semantics — no named
 * captures. Only `*` is special (matches any characters including `/`); every
 * other character (including `:`) is treated as a literal.
 *
 * This preserves the pre-`feat/rewrites` semantics of header rules,
 * `routing.revalidate` keys, and `routing.revalidateQueryAllowlist` keys —
 * those callers never had `:name` capture syntax and existing tenant configs
 * may include literal `:` (e.g. `/api/v1:health`, `:batchGet`-style URLs).
 *
 * The capture-aware `matchPattern` above continues to be used by routing
 * rules (`redirects`/`rewrites`/`fallbacks`) where `:name` capture syntax was
 * intentionally introduced (see design-doc 0064).
 */
export function matchLiteralPattern(pattern: string, pathname: string): boolean {
  let regex = literalRegexCache.get(pattern);
  if (regex) {
    // LRU touch — same scheme as the legacy header matcher.
    literalRegexCache.delete(pattern);
    literalRegexCache.set(pattern, regex);
  } else {
    try {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
      regex = new RegExp(`^${escaped}$`);
    } catch {
      return false;
    }
    if (literalRegexCache.size >= MAX_CACHE) {
      const first = literalRegexCache.keys().next();
      if (!first.done) {
        literalRegexCache.delete(first.value);
      }
    }
    literalRegexCache.set(pattern, regex);
  }
  try {
    return regex.test(pathname);
  } catch {
    return false;
  }
}

/**
 * Substitute `:name` and `:name*` tokens in a destination string with the
 * matching named captures from `params`. `:splat` works for legacy `*` patterns
 * because `compilePattern` captures anonymous `*` as `splat`.
 */
export function substituteParams(destination: string, params: Record<string, string>): string {
  return destination.replace(/:([A-Za-z0-9_]+)\*?/g, (whole, name: string) => {
    return params[name] ?? whole;
  });
}
