export interface HeaderRule {
  pattern: string;
  headers: [string, string][];
}

/**
 * Match a pattern against a pathname.
 * `*` matches any characters including `/`.
 */
export function matchPattern(pattern: string, pathname: string): boolean {
  // Escape regex special chars except `*`, then convert `*` to `.*`
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(pathname);
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
    newResponse.headers.set(name, value);
  }

  return newResponse;
}
