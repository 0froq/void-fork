import {
  PLATFORM_LOGIN_KINDS,
  parsePlatformLoginConfiguration,
  type PlatformLoginConfiguration,
} from '@void/platform';
import { and, eq, gt } from 'drizzle-orm';
import { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
import { requireUncachedAuthenticationDatabase } from '../../auth/bootstrap.ts';
import {
  AuthenticationConfigurationError,
  importLegacyAuthentication,
} from '../../auth/configuration.ts';
import { createLoginTestLaunch } from '../../auth/login.ts';
import type { ApiEnv } from '../../env.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import {
  authenticationActor,
  changeAuthenticationConnection,
  configureAuthenticationAdmission,
  configureAuthenticationConnection,
  getAuthenticationConfiguration,
} from '../../operator/auth-config.ts';
import { OperatorError } from '../../operator/common.ts';
import { getPlatformDisplayName } from '../../platform-identity.ts';
import { platformLoginTests } from '../../schema.ts';
import { renderAdminPage } from '../react/server.ts';

const app = new Hono<ApiEnv>();
const HOME = '/admin/config/auth';
app.use('*', async (context, next) => {
  context.header('Cache-Control', 'no-store');
  context.header('Referrer-Policy', 'no-referrer');
  await next();
});
app.onError((error, context) => {
  if (error instanceof OperatorError || error instanceof AuthenticationConfigurationError) {
    return renderAdminPage(
      context,
      'authError',
      'Authentication settings',
      {
        message: error.message,
        platformName: getPlatformDisplayName(context.env, context.req.url),
        username: context.get('user')?.login,
      },
      { status: error.status },
    );
  }
  throw error;
});

app.get('/', async (context) => {
  const data = await getAuthenticationConfiguration(context);
  const testId = context.req.query('test');
  const [tested] = testId
    ? await context
        .get('db')
        .select()
        .from(platformLoginTests)
        .where(
          and(
            eq(platformLoginTests.id, testId),
            eq(platformLoginTests.user_id, context.get('user').id),
            gt(platformLoginTests.expires_at, new Date().toISOString()),
          ),
        )
    : [];
  const admission = 'admission' in data ? data.admission : undefined;
  return renderAdminPage(context, 'authSettings', 'Authentication settings', {
    data,
    tested,
    admission,
    platformName: getPlatformDisplayName(context.env, context.req.url),
    username: context.get('user').login,
  });
});

app.get('/new', async (context) => {
  const kind = context.req.query('kind') as PlatformLoginConfiguration['kind'];
  if (!PLATFORM_LOGIN_KINDS.includes(kind)) {
    throw new OperatorError(400, 'Select a supported login method.');
  }
  const id = kind === 'oidc' ? 'company' : kind === 'cloudflare-access' ? 'access' : kind;
  return renderAdminPage(context, 'authNew', 'Add login method', {
    kind,
    id,
    callbackUrl: context.env.AUTH_REDIRECT_URI ?? new URL('/auth/callback', context.req.url).href,
    platformName: getPlatformDisplayName(context.env, context.req.url),
    username: context.get('user').login,
  });
});
app.get('/connections/:id', async (context) => {
  const data = await getAuthenticationConfiguration(context);
  const method = data.methods.find((method) => method.id === context.req.param('id'));
  if (
    !method ||
    !('configuration' in method) ||
    !method.configuration ||
    !('revision' in method) ||
    typeof method.revision !== 'number'
  ) {
    throw new OperatorError(404, 'Login method not found.');
  }
  return renderAdminPage(context, 'authEdit', 'Edit login method', {
    configuration: parsePlatformLoginConfiguration(method.configuration),
    label: method.label,
    revision: method.revision,
    callbackUrl: context.env.AUTH_REDIRECT_URI ?? new URL('/auth/callback', context.req.url).href,
    platformName: getPlatformDisplayName(context.env, context.req.url),
    username: context.get('user').login,
  });
});
app.post('/initialize', async (context) =>
  executeAuditedMutation(context, operatorAuditIntent('config/auth/initialize'), async () => {
    requireUncachedAuthenticationDatabase(context.env);
    await importLegacyAuthentication(context.get('db'), context.env);
    deleteCookie(context, 'admin_token', { path: '/' });
    return { response: context.redirect('/admin/login'), succeeded: true };
  }),
);
app.post('/connections/:id/configure', async (context) => {
  const body = await context.req.parseBody();
  const revision = body.revision ? Number(body.revision) : null;
  const id = revision === null ? String(body.connectionId) : context.req.param('id');
  const action = `config/auth/connections/${id}/configure`;
  return executeAuditedMutation(context, operatorAuditIntent(action, { revision }), async () => {
    await configureAuthenticationConnection(context, id, {
      revision,
      configuration: {
        id,
        kind: String(body.kind),
        label: String(body.label),
        clientId: String(body.clientId),
        ...(body.issuer ? { issuer: String(body.issuer) } : {}),
        allowedDomains: String(body.domains ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        requiredGroups: String(body.groups ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      },
      ...(body.clientSecret ? { clientSecret: String(body.clientSecret) } : {}),
    });
    return { response: context.redirect(HOME), succeeded: true };
  });
});
app.post('/connections/:id/test', async (context) =>
  executeAuditedMutation(
    context,
    operatorAuditIntent(`config/auth/connections/${context.req.param('id')}/test`),
    async () => {
      const launch = await createLoginTestLaunch(
        context,
        authenticationActor(context),
        context.req.param('id'),
      );
      return { response: context.redirect(launch.url), succeeded: true };
    },
  ),
);
for (const action of ['enable', 'disable', 'link'] as const) {
  app.post(`/connections/:id/${action}`, async (context) => {
    const form = await context.req.parseBody();
    const body = {
      revision: Number(form.revision),
      ...(form.testId ? { testId: String(form.testId) } : {}),
    };
    return executeAuditedMutation(
      context,
      operatorAuditIntent(`config/auth/connections/${context.req.param('id')}/${action}`, body),
      async () => {
        await changeAuthenticationConnection(context, context.req.param('id'), action, body);
        return {
          response: context.redirect(
            action === 'link' ? `${HOME}?test=${encodeURIComponent(body.testId!)}` : HOME,
          ),
          succeeded: true,
        };
      },
    );
  });
}
app.post('/admission', async (context) => {
  const form = await context.req.parseBody({ all: true });
  const connections = Array.isArray(form.connections)
    ? form.connections.map(String)
    : form.connections
      ? [String(form.connections)]
      : [];
  const body = {
    revision: Number(form.revision),
    admission: { mode: String(form.mode), connections, access: form.access === 'true' },
  };
  return executeAuditedMutation(
    context,
    operatorAuditIntent('config/auth/admission', body),
    async () => {
      await configureAuthenticationAdmission(context, body);
      return { response: context.redirect(HOME), succeeded: true };
    },
  );
});
export default app;
