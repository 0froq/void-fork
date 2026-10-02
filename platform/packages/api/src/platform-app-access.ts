import {
  parsePlatformAppAccessSetup,
  PLATFORM_APP_ACCESS_SETUP_PROOF_PREFIX,
  PLATFORM_DISABLED_KEY,
  PLATFORM_DISABLED_VALUE,
  type PlatformAppAccessSetup,
} from '@void/platform';
import { sql } from 'drizzle-orm';
import type { Context } from 'hono';
import type { Db } from './db.ts';
import type { ApiEnv } from './env.ts';
import { getPlatformSetting, setPlatformSetting } from './platform-settings.ts';
import { ZeroTrustCloudflareError } from './zero-trust/cloudflare.ts';
import {
  readZeroTrustConfigurationStrict,
  type ZeroTrustConfiguration,
} from './zero-trust/configuration.ts';
import { ZeroTrustUnavailableError } from './zero-trust/errors.ts';
import { configurePlatformZeroTrust } from './zero-trust/installation.ts';
import { lockZeroTrustConfiguration } from './zero-trust/lock.ts';
import { zeroTrustStatus } from './zero-trust/status.ts';

const SETTING = 'appAccess.installation.v1';
type SetupReceipt = { version: 1; requestHash: string; complete: boolean };

function sameSelection(current: ZeroTrustConfiguration, setup: PlatformAppAccessSetup): boolean {
  return (
    current.accountId === setup.accountId &&
    !!current.publicAccess === (setup.mode === 'public') &&
    current.protectNewProjects === (setup.mode === 'protected') &&
    JSON.stringify(current.identityProviderIds) === JSON.stringify(setup.identityProviderIds) &&
    JSON.stringify(current.policyIds) === JSON.stringify(setup.policyIds)
  );
}

/** One-time installer handoff. Later administrator settings are never reapplied or reset. */
export async function initializePlatformAppAccess(
  env: ApiEnv['Bindings'],
  db: Db,
  setup: PlatformAppAccessSetup,
) {
  if (
    !env.PLATFORM_APP_ACCESS ||
    !env.PLATFORM_INSTALLATION_ID ||
    setup.accountId !== env.CF_ACCOUNT_ID ||
    setup.mode !== (env.PLATFORM_APP_ACCESS === 'public' ? 'public' : 'protected')
  ) {
    throw new Error('App access does not match the installation’s account or saved choice.');
  }
  const { apiToken: _token, ...identity } = setup;
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(identity))),
  );
  const requestHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const claim = await db.transaction(async (tx) => {
    await lockZeroTrustConfiguration(tx, 'exclusive');
    const value = await getPlatformSetting(tx, SETTING);
    const receipt = value as SetupReceipt | null;
    if (
      receipt &&
      (receipt.version !== 1 ||
        typeof receipt.requestHash !== 'string' ||
        typeof receipt.complete !== 'boolean')
    ) {
      throw new Error('The saved app access setup receipt is invalid.');
    }
    if (receipt?.complete) {
      return { complete: true };
    }
    if (receipt && receipt.requestHash !== requestHash) {
      throw new Error('Resume with the saved app access selections.');
    }
    const result = await tx.execute(
      sql`SELECT installation_id, lifecycle_manifest FROM __void_platform_installation WHERE singleton = true FOR SHARE`,
    );
    const row = result.rows[0] as
      | {
          installation_id?: string;
          lifecycle_manifest?: {
            id?: string;
            status?: string;
            deployment?: { appAccess?: string };
          };
        }
      | undefined;
    if (
      !row ||
      row.installation_id !== env.PLATFORM_INSTALLATION_ID ||
      row.lifecycle_manifest?.id !== env.PLATFORM_INSTALLATION_ID ||
      row.lifecycle_manifest?.deployment?.appAccess !== env.PLATFORM_APP_ACCESS ||
      !['provisioning', 'deploying', 'verifying'].includes(row.lifecycle_manifest?.status ?? '')
    ) {
      throw new Error(
        'App access initialization is only available during the recorded installation setup.',
      );
    }
    const current = await readZeroTrustConfigurationStrict(tx);
    if (!receipt && current) {
      if (current.operation || current.lastError) {
        throw new Error('Reconcile the existing app access settings before resuming installation.');
      }
      await setPlatformSetting(tx, SETTING, {
        version: 1,
        requestHash,
        complete: true,
      } satisfies SetupReceipt);
      return { complete: true };
    }
    if (current && !sameSelection(current, setup)) {
      throw new Error(
        'App access was changed outside installation. Inspect Admin → Zero Trust before resuming.',
      );
    }
    await setPlatformSetting(tx, SETTING, {
      version: 1,
      requestHash,
      complete: !setup.managed,
    } satisfies SetupReceipt);
    return { complete: !setup.managed };
  });
  if (claim.complete) {
    return { ready: true };
  }
  const current = await readZeroTrustConfigurationStrict(db);
  if (current?.operation?.kind === 'disable') {
    throw new Error(
      'An administrator is disabling app access. Finish that operation before resuming installation.',
    );
  }
  const existingProjects = current?.operation
    ? (current.operation.existingProjects ?? undefined)
    : current?.enabled
      ? undefined
      : setup.mode === 'protected'
        ? 'protected'
        : 'public';
  await configurePlatformZeroTrust(env, db, {
    apiToken: setup.apiToken!,
    identityProviderIds: setup.identityProviderIds,
    policyIds: setup.policyIds,
    protectNewProjects: setup.mode === 'protected',
    ...(existingProjects ? { existingProjects } : {}),
    ...(setup.mode === 'public' ? { publicAccess: true as const } : {}),
    managePublicCustomDomains: true,
  });
  const status = await zeroTrustStatus(env, db, { check: true });
  if (
    !status.enabled ||
    status.status !== 'ready' ||
    !status.live?.present ||
    status.live.drifted ||
    status.projects.some((project) => project.state === 'error' || project.state === 'reconciling')
  ) {
    return { ready: false };
  }
  await db.transaction(async (tx) => {
    await lockZeroTrustConfiguration(tx, 'exclusive');
    const receipt = (await getPlatformSetting(tx, SETTING)) as SetupReceipt | null;
    const current = await readZeroTrustConfigurationStrict(tx);
    if (
      receipt?.requestHash !== requestHash ||
      !current ||
      !sameSelection(current, setup) ||
      current.operation ||
      current.lastError
    ) {
      throw new Error('App access changed while setup was being verified. Resume installation.');
    }
    await setPlatformSetting(tx, SETTING, { ...receipt, complete: true });
  });
  return { ready: true };
}

export async function platformAppAccess(context: Context<ApiEnv>): Promise<Response> {
  const token = context.env.PLATFORM_HEALTH_PROBE_TOKEN;
  if (
    !token ||
    context.req.header('X-Void-Platform-Probe') !== token ||
    !context.env.PLATFORM_INSTALLATION_ID ||
    !context.env.PLATFORM_APP_ACCESS
  ) {
    return context.json({ error: 'not found' }, 404);
  }
  const setupKey = context.env.PLATFORM_APP_ACCESS_SETUP_TOKEN;
  const signature = context.req.header('X-Void-App-Access-Setup') ?? '';
  if (!setupKey || setupKey.length < 32 || !/^[A-Za-z0-9_-]{43}$/.test(signature)) {
    return context.json({ error: 'not found' }, 404);
  }
  const body = await context.req.text();
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(setupKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const proof = Uint8Array.from(atob(signature.replaceAll('-', '+').replaceAll('_', '/')), (byte) =>
    byte.charCodeAt(0),
  );
  if (
    !(await crypto.subtle.verify(
      'HMAC',
      key,
      proof,
      new TextEncoder().encode(
        `${PLATFORM_APP_ACCESS_SETUP_PROOF_PREFIX}\n${context.env.PLATFORM_INSTALLATION_ID}\n${body}`,
      ),
    ))
  ) {
    return context.json({ error: 'not found' }, 404);
  }
  let setup: PlatformAppAccessSetup;
  try {
    setup = parsePlatformAppAccessSetup(JSON.parse(body));
  } catch {
    return context.json({ error: 'Invalid app access setup.' }, 400);
  }
  try {
    // A completed receipt is harmless to replay; initialization itself happens behind the traffic gate.
    const receipt = (await getPlatformSetting(context.get('db'), SETTING)) as SetupReceipt | null;
    if (
      !receipt?.complete &&
      context.env.PLATFORM_TRAFFIC_STATE !== 'staging' &&
      (await context.env.ROUTING.get(PLATFORM_DISABLED_KEY)) !== PLATFORM_DISABLED_VALUE
    ) {
      return context.json({ error: 'Close app traffic before initializing app access.' }, 409);
    }
    const result = await initializePlatformAppAccess(context.env, context.get('db'), setup);
    return context.json(
      { installationId: context.env.PLATFORM_INSTALLATION_ID, ...result },
      result.ready ? 200 : 202,
    );
  } catch (error) {
    console.error('[platform] app access setup failed', error);
    if (error instanceof ZeroTrustCloudflareError && [401, 403].includes(error.status)) {
      return context.json(
        {
          error:
            'The app access token needs Access Apps and Policies Edit plus Organizations, Identity Providers, and Groups Read in the hosting account.',
          code: 'app_access_credentials',
        },
        403,
      );
    }
    if (error instanceof ZeroTrustUnavailableError) {
      return context.json({ error: error.message }, 409);
    }
    return context.json(
      {
        error:
          'App access is not ready. Check the Access token, identity providers, and policy selections, then resume.',
      },
      503,
    );
  }
}
