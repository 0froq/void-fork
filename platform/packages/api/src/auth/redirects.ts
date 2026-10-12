import { DEFAULT_DASHBOARD_URL } from '../constants.ts';

export function isAllowedRedirect(
  url: string,
  dashboardUrl?: string,
  platformInstallationId?: string,
  companionCallbacks?: string,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (isCompanionRedirect(url, companionCallbacks)) {
    return true;
  }

  // Localhost: allow any port, require exact hostname and http protocol
  if (isLocalhostRedirect(parsed)) {
    return true;
  }

  // Dashboard: compare exact origin (protocol + hostname + port)
  const origin = dashboardUrl ?? (platformInstallationId ? null : DEFAULT_DASHBOARD_URL);
  if (!origin) {
    return false;
  }
  try {
    return parsed.origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

export function isLocalhostRedirect(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

/** Administrator-registered exact callback URLs; only the PKCE state query is variable. */
export function isCompanionRedirect(url: string, callbacks?: string): boolean {
  if (!callbacks) {
    return false;
  }
  try {
    const registered: unknown = JSON.parse(callbacks);
    const candidate = new URL(url);
    if (
      candidate.protocol !== 'https:' ||
      candidate.username ||
      candidate.password ||
      candidate.hash
    ) {
      return false;
    }
    candidate.searchParams.delete('state');
    return (
      Array.isArray(registered) &&
      registered.some((value) => {
        if (typeof value !== 'string') {
          return false;
        }
        const callback = new URL(value);
        return (
          callback.protocol === 'https:' &&
          !callback.username &&
          !callback.password &&
          !callback.hash &&
          callback.href === candidate.href
        );
      })
    );
  } catch {
    return false;
  }
}
