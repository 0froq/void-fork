import { compilePattern, substituteParams } from './pattern.ts';

export interface RedirectRule {
  source: string;
  destination: string;
  status: number;
  /**
   * Optional literal host the rule is scoped to. The framework parser
   * splits a `https://host/path` source into `host` and a path-only
   * `source`, lowercase-normalized. Dispatch matches `host` byte-for-byte
   * against `url.hostname` at request time. Optional — path-only rules
   * apply to every host bound to the project.
   */
  host?: string;
}

export type RoutingRuleResult =
  | { type: 'redirect'; destination: string; status: number }
  | { type: 'rewrite'; destination: string };

/**
 * Check routing rules (redirects + rewrites) against a request pathname.
 * Last match wins (consistent with header rules).
 *
 * Returns a discriminated result. The caller is responsible for building the
 * actual `Response` for redirects (so it can merge the request's query string
 * into the `Location` header).
 */
export function applyRoutingRules(
  pathname: string,
  rules?: Array<RedirectRule>,
): RoutingRuleResult | null {
  if (!rules?.length) {
    return null;
  }

  // A malformed `source` (e.g. duplicate named params) throws inside
  // `new RegExp`. Framework validation rejects those at build, but a
  // hand-crafted manifest could still reach the edge. Skip the offending rule
  // and continue rather than 500ing the whole request.
  let matched: { rule: RedirectRule; params: Record<string, string> } | undefined;
  for (const rule of rules) {
    let regex: RegExp;
    try {
      ({ regex } = compilePattern(rule.source));
    } catch (err) {
      console.warn(
        `[dispatch] skipping routing rule with invalid source ${JSON.stringify(rule.source)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const m = regex.exec(pathname);
    if (m) {
      matched = { rule, params: m.groups ?? {} };
    }
  }

  if (!matched) {
    return null;
  }

  const destination = substituteParams(matched.rule.destination, matched.params);

  if (matched.rule.status === 200) {
    return { type: 'rewrite', destination };
  }

  return { type: 'redirect', destination, status: matched.rule.status };
}

/**
 * Merge a request's query string into a redirect destination.
 *
 * If the destination already contains a `?`, its parameters take precedence
 * over the request's. Otherwise the request's query is appended verbatim.
 *
 * A `#fragment` on the destination is stripped before the merge and
 * re-appended afterwards, so `/new#faq` + `?utm=x` becomes `/new?utm=x#faq`
 * rather than `/new#faq?utm=x` (which browsers treat as fragment text).
 */
export function mergeQueryIntoLocation(destination: string, requestSearch: string): string {
  if (!requestSearch || requestSearch === '?') {
    return destination;
  }
  const fragIdx = destination.indexOf('#');
  const base = fragIdx === -1 ? destination : destination.slice(0, fragIdx);
  const fragment = fragIdx === -1 ? '' : destination.slice(fragIdx);

  const destQueryIdx = base.indexOf('?');
  if (destQueryIdx === -1) {
    return base + requestSearch + fragment;
  }
  if (destQueryIdx === base.length - 1) {
    return base.slice(0, destQueryIdx) + fragment;
  }
  const reqParams = new URLSearchParams(requestSearch);
  const destParams = new URLSearchParams(base.slice(destQueryIdx + 1));
  for (const [key, value] of reqParams) {
    if (!destParams.has(key)) {
      destParams.append(key, value);
    }
  }
  return base.slice(0, destQueryIdx) + '?' + destParams.toString() + fragment;
}
