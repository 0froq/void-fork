import { createHmac } from 'node:crypto';
import { parsePlatformAuthenticationSetup, PLATFORM_AUTH_SETUP_PROOF_PREFIX } from '@void/platform';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import { normalizePlatformApiUrl } from './platform-registry.ts';

export async function initializeInstalledPlatformAuthentication(
  apiUrl: string,
  installationId: string,
  setupToken: string,
  setupJson: string,
  fetcher: typeof fetch = fetch,
): Promise<{ setupPending: boolean; expiresAt: string | null }> {
  const origin = normalizePlatformApiUrl(apiUrl);
  const body = JSON.stringify(parsePlatformAuthenticationSetup(JSON.parse(setupJson)));
  const signature = createHmac('sha256', setupToken)
    .update(`${PLATFORM_AUTH_SETUP_PROOF_PREFIX}\n${installationId}\n${body}`)
    .digest('base64url');
  const response = await fetcher(`${origin}/internal/platform/auth-initialize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Void-Auth-Setup': signature,
      ...cfAccessHeaders(process.env, origin),
    },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `platform: Authentication setup failed (HTTP ${response.status}). Its outcome may be unknown; preserve the encrypted setup checkpoint and resume installation.`,
    );
  }
  const result = (await response.json()) as { setupPending?: unknown; expiresAt?: unknown };
  if (
    typeof result.setupPending !== 'boolean' ||
    (result.setupPending &&
      (typeof result.expiresAt !== 'string' || !Number.isFinite(Date.parse(result.expiresAt))))
  ) {
    throw new Error('platform: The platform returned an invalid authentication setup response.');
  }
  return {
    setupPending: result.setupPending,
    expiresAt: typeof result.expiresAt === 'string' ? result.expiresAt : null,
  };
}
