import { matchLiteralPattern } from './pattern.ts';

export type HeaderRule = Readonly<{
  pattern: string;
  headers: ReadonlyArray<[string, string]>;
}>;

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

/**
 * Apply matching header rules to a response.
 * All matching rules merge; last match wins for same header name.
 * Returns the original response unchanged when no rules or no matches.
 */
export function applyHeaderRules(
  response: Response,
  pathname: string,
  rules?: ReadonlyArray<HeaderRule>,
): Response {
  if (!rules || rules.length === 0) {
    return response;
  }

  const matched: Array<[string, string]> = [];
  for (const rule of rules) {
    if (matchLiteralPattern(rule.pattern, pathname)) {
      matched.push(...rule.headers);
    }
  }

  if (matched.length === 0) {
    return response;
  }

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
