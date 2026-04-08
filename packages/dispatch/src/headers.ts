export interface HeaderRule {
  pattern: string;
  headers: [string, string][];
}

/**
 * Headers that user header rules are not allowed to set.
 * Only set-cookie is blocked because on the shared *.void.app domain
 * (not on the PSL), a cookie with Domain=.void.app is readable by all
 * tenants. HSTS and other per-domain headers are safe — they don't
 * cross subdomain boundaries.
 *
 * TODO: Once void.app is registered on the Public Suffix List, this
 * denylist can be removed entirely — browsers will reject cross-subdomain
 * cookies automatically. Until then, this is the primary defense.
 */
const BLOCKED_HEADERS = new Set(['set-cookie']);

const MAX_CACHE = 256;
const regexCache = new Map<string, RegExp>();

/**
 * Match a pattern against a pathname.
 * `*` matches any characters including `/`.
 */
export function matchPattern(pattern: string, pathname: string): boolean {
  let regex = regexCache.get(pattern);
  if (regex) {
    // Move to end (most recently used)
    regexCache.delete(pattern);
    regexCache.set(pattern, regex);
  } else {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
    regex = new RegExp(`^${escaped}$`);
    if (regexCache.size >= MAX_CACHE) {
      regexCache.delete(regexCache.keys().next().value!);
    }
    regexCache.set(pattern, regex);
  }
  return regex.test(pathname);
}

/**
 * Apply matching header rules to a response.
 * All matching rules merge; last match wins for same header name.
 * Returns the original response unchanged when no rules or no matches.
 */
export function applyHeaderRules(
  response: Response,
  pathname: string,
  rules?: HeaderRule[],
): Response {
  if (!rules || rules.length === 0) return response;

  const matched: [string, string][] = [];
  for (const rule of rules) {
    if (matchPattern(rule.pattern, pathname)) {
      matched.push(...rule.headers);
    }
  }

  if (matched.length === 0) return response;

  // Clone response to modify headers
  const newResponse = new Response(response.body, response);
  for (const [name, value] of matched) {
    if (BLOCKED_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    newResponse.headers.set(name, value);
  }

  return newResponse;
}
