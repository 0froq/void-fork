import { matchPattern } from './headers';

export interface RedirectRule {
  source: string;
  destination: string;
  status: number;
}

/**
 * Check redirect rules against a request pathname.
 * Last match wins (consistent with header rules).
 * Returns a redirect Response, or null if no rule matches.
 */
export function applyRedirectRules(pathname: string, rules?: RedirectRule[]): Response | null {
  if (!rules?.length) {
    return null;
  }

  let matched: RedirectRule | undefined;
  for (const rule of rules) {
    if (matchPattern(rule.source, pathname)) {
      matched = rule;
    }
  }

  if (!matched) {
    return null;
  }

  let dest = matched.destination;
  if (dest.includes(':splat') && matched.source.includes('*')) {
    const prefix = matched.source.split('*')[0];
    const splat = pathname.slice(prefix.length);
    dest = dest.replace(':splat', splat);
  }

  return new Response(null, {
    status: matched.status,
    headers: { Location: dest },
  });
}
