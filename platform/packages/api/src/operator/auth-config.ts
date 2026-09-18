import { parsePlatformLoginConfiguration, parsePlatformAdmissionPolicy } from '@void/platform';
import { and, eq, gt } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { requireUncachedAuthenticationDatabase } from '../auth/bootstrap.ts';
import {
  importLegacyAuthentication,
  readAuthSettings,
  readLoginConnection,
  readLoginRevision,
  readLoginSecret,
  stageLoginConfiguration,
} from '../auth/configuration.ts';
import { createLoginTestLaunch } from '../auth/login.ts';
import {
  disableLoginConnection,
  enableLoginConnection,
  linkTestedIdentity,
  type AuthenticationActor,
  updateAuthenticationAdmission,
} from '../auth/management.ts';
import { getPlatformCapabilities } from '../capabilities.ts';
import type { ApiEnv } from '../env.ts';
import { platformLoginConnections, platformLoginTests } from '../schema.ts';
import { dryRun, OperatorError, preview, readBody, stringField } from './common.ts';

export function authenticationActor(context: Context<ApiEnv>): AuthenticationActor {
  const session = context.get('humanSession');
  if (!session) {
    throw new OperatorError(
      401,
      'Sign in again to manage platform authentication.',
      'reauthentication_required',
    );
  }
  return {
    userId: context.get('user').id,
    sessionId: session.id,
    audience: session.audience,
    companyIdentity: context.get('companyIdentity'),
  };
}

function revisionField(value: unknown, nullable = false): number | null {
  if (value === null && nullable) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new OperatorError(
      400,
      'A positive integer configuration revision is required.',
      'invalid_argument',
    );
  }
  return value;
}

export async function getAuthenticationConfiguration(context: Context<ApiEnv>) {
  const db = context.get('db');
  const settings = await readAuthSettings(db);
  if (!settings) {
    const capabilities = getPlatformCapabilities(context.env);
    return {
      initialized: false,
      methods: [
        ...(capabilities.githubOAuth
          ? [{ id: 'github', kind: 'github', label: 'GitHub', enabled: true }]
          : []),
        ...(capabilities.googleOAuth
          ? [{ id: 'google', kind: 'google', label: 'Google', enabled: true }]
          : []),
      ],
      protection: null,
    };
  }
  const connections = await db
    .select()
    .from(platformLoginConnections)
    .orderBy(platformLoginConnections.id);
  const methods = await Promise.all(
    connections.map(async (connection) => {
      const pending = await readLoginRevision(db, connection.id, connection.revision);
      const active = connection.active_revision
        ? await readLoginRevision(db, connection.id, connection.active_revision)
        : null;
      return {
        id: connection.id,
        kind: connection.kind,
        enabled: connection.enabled,
        revision: connection.revision,
        activeRevision: connection.active_revision,
        label: pending?.configuration.label ?? connection.id,
        configuration: pending?.configuration,
        activeConfiguration: active?.configuration,
        credentialConfigured: !!pending?.secret,
      };
    }),
  );
  return {
    initialized: true,
    revision: settings.revision,
    admission: settings.admission,
    protection: settings.protection,
    callbackUrl: context.env.AUTH_REDIRECT_URI ?? new URL('/auth/callback', context.req.url).href,
    sessionSeconds: settings.session_seconds,
    methods,
  };
}

export async function configureAuthenticationConnection(
  context: Context<ApiEnv>,
  id: string,
  body: Record<string, unknown>,
) {
  authenticationActor(context);
  let configuration;
  try {
    configuration = parsePlatformLoginConfiguration(body.configuration);
  } catch (error) {
    throw new OperatorError(
      400,
      error instanceof Error ? error.message : 'Invalid login configuration.',
      'invalid_argument',
    );
  }
  if (configuration.id !== id) {
    throw new OperatorError(
      400,
      'The configuration ID must match the selected connection.',
      'invalid_argument',
    );
  }
  const revision = revisionField(body.revision, true);
  let secret = body.clientSecret;
  if (secret === undefined && revision !== null) {
    const current = await readLoginRevision(context.get('db'), id, revision);
    if (current) {
      secret = await readLoginSecret(context.env, current);
    }
  }
  if (typeof secret !== 'string') {
    throw new OperatorError(
      400,
      'A client secret is required for a new login connection.',
      'invalid_argument',
    );
  }
  const result = await stageLoginConfiguration(
    context.get('db'),
    context.env,
    configuration,
    secret,
    revision,
    dryRun(body),
  );
  return dryRun(body)
    ? preview('Configure login method', id, {
        configuration,
        revision: result.revision,
        credentialConfigured: true,
      })
    : {
        id,
        revision: result.revision,
        enabled: result.enabled,
        activeRevision: result.active_revision,
      };
}

export async function changeAuthenticationConnection(
  context: Context<ApiEnv>,
  id: string,
  action: 'enable' | 'disable' | 'link',
  body: Record<string, unknown>,
) {
  const actor = authenticationActor(context);
  const revision = revisionField(body.revision)!;
  const input = {
    connectionId: id,
    revision,
    testId: action === 'disable' ? '' : stringField(body, 'testId'),
  };
  if (action === 'disable') {
    await disableLoginConnection(context.get('db'), actor, input, dryRun(body));
  } else if (action === 'enable') {
    await enableLoginConnection(context.get('db'), actor, input, dryRun(body));
  } else {
    await linkTestedIdentity(context.get('db'), actor, input, dryRun(body));
  }
  return dryRun(body)
    ? preview(`${action} login method`, id, {
        revision,
        revokesHumanSessions: action !== 'link',
        preservesScopedDeploymentTokens: true,
      })
    : { ok: true };
}

export const authenticationConfigRoutes = new Hono<ApiEnv>();
export async function configureAuthenticationAdmission(
  context: Context<ApiEnv>,
  body: Record<string, unknown>,
) {
  await updateAuthenticationAdmission(
    context.get('db'),
    authenticationActor(context),
    {
      revision: revisionField(body.revision)!,
      admission: body.admission,
    },
    dryRun(body),
  );
  return dryRun(body)
    ? preview('Change signup policy', 'platform', {
        admission: parsePlatformAdmissionPolicy(body.admission),
      })
    : { ok: true };
}
authenticationConfigRoutes.post('/config/auth/admission', async (context) =>
  context.json(await configureAuthenticationAdmission(context, await readBody(context))),
);
authenticationConfigRoutes.get('/config/auth', async (context) =>
  context.json(await getAuthenticationConfiguration(context)),
);
authenticationConfigRoutes.post('/config/auth/initialize', async (context) => {
  const body = await readBody(context);
  requireUncachedAuthenticationDatabase(context.env);
  if (dryRun(body)) {
    return context.json(
      preview('Initialize authentication settings', 'platform', {
        preservesProviders: true,
        signInAgain: true,
      }),
    );
  }
  await importLegacyAuthentication(context.get('db'), context.env);
  return context.json({ initialized: true, signInAgain: true });
});
authenticationConfigRoutes.post('/config/auth/connections/:id/configure', async (context) =>
  context.json(
    await configureAuthenticationConnection(
      context,
      context.req.param('id'),
      await readBody(context),
    ),
  ),
);
authenticationConfigRoutes.post('/config/auth/connections/:id/test', async (context) => {
  const body = await readBody(context);
  const actor = authenticationActor(context);
  const id = context.req.param('id');
  if (!(await readLoginConnection(context.get('db'), id))) {
    throw new OperatorError(404, 'Login connection not found.', 'not_found');
  }
  if (dryRun(body)) {
    return context.json(preview('Test login method', id));
  }
  return context.json(await createLoginTestLaunch(context, actor, id));
});
authenticationConfigRoutes.get('/config/auth/tests/:id', async (context) => {
  const [result] = await context
    .get('db')
    .select()
    .from(platformLoginTests)
    .where(
      and(
        eq(platformLoginTests.id, context.req.param('id')),
        eq(platformLoginTests.user_id, context.get('user').id),
        gt(platformLoginTests.expires_at, new Date().toISOString()),
      ),
    );
  return context.json(
    result
      ? {
          complete: true,
          id: result.id,
          connectionId: result.connection_id,
          revision: result.revision,
          issuer: result.issuer,
          subject: result.subject,
          login: result.login || result.subject,
          expiresAt: result.expires_at,
        }
      : { complete: false },
  );
});
for (const action of ['enable', 'disable', 'link'] as const) {
  authenticationConfigRoutes.post(`/config/auth/connections/:id/${action}`, async (context) =>
    context.json(
      await changeAuthenticationConnection(
        context,
        context.req.param('id'),
        action,
        await readBody(context),
      ),
    ),
  );
}
