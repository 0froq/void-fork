import type { PlatformLoginConfiguration } from '@void/platform';
import { and, eq, gt } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { storeAuthCode, type Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { platformAuthAttempts, platformLoginTests } from '../schema.ts';
import {
  AuthenticationConfigurationError,
  lockAuthSettings,
  readAuthSettings,
  readLoginConnection,
  readLoginRevision,
  readLoginSecret,
} from './configuration.ts';
import { exchangeCodeForToken, getGitHubAuthorizeUrl, getGitHubUser } from './github.ts';
import { resolvePlatformLogin } from './identities.ts';
import type { AuthenticationActor } from './management.ts';
import { PlatformOidcProvider, type PlatformOidcIdentity } from './oidc.ts';
import { createCodeChallenge } from './pkce.ts';
import { isAllowedRedirect, isLocalhostRedirect } from './redirects.ts';
import { createHumanSession, validateHumanSession, type CompanyIdentity } from './sessions.ts';

const COOKIE = 'void_platform_auth';
const FLOW_SECONDS = 600;
const providers = new Map<string, PlatformOidcProvider>();

type LoginContext = {
  redirect: string;
  redirectUri: string;
  verifier: string;
  nonce?: string;
  cliState?: string;
  codeChallenge?: string;
  companyIdentity?: CompanyIdentity;
  actor?: AuthenticationActor;
  testId?: string;
};

function oidcProvider(configuration: PlatformLoginConfiguration): PlatformOidcProvider {
  const key = JSON.stringify(configuration);
  let provider = providers.get(key);
  if (!provider) {
    if (providers.size >= 32) {
      providers.delete(providers.keys().next().value!);
    }
    provider = new PlatformOidcProvider(configuration);
    providers.set(key, provider);
  }
  return provider;
}

export async function hashLoginProof(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function authenticationError(context: Context<ApiEnv>, error: unknown): Response {
  if (error instanceof AuthenticationConfigurationError) {
    return context.json(
      { error: error.code, message: error.message },
      error.status as ContentfulStatusCode,
    );
  }
  // Provider responses may contain secrets or untrusted data. Do not echo or log them.
  return context.json(
    {
      error: 'login_failed',
      message:
        'Login could not be completed. Start a new login or check the provider configuration.',
    },
    400,
  );
}

async function authorizationFor(
  configuration: PlatformLoginConfiguration,
  redirectUri: string,
  state: string,
): Promise<{ url: string; verifier: string; nonce?: string }> {
  if (configuration.kind !== 'github') {
    return oidcProvider(configuration).authorize(redirectUri, state);
  }
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const url = new URL(getGitHubAuthorizeUrl(configuration.clientId, redirectUri, state));
  url.searchParams.set('code_challenge', await createCodeChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.href, verifier };
}

function bindBrowser(context: Context<ApiEnv>, proof: string): void {
  setCookie(context, COOKIE, proof, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/auth/callback',
    maxAge: FLOW_SECONDS,
  });
  context.header('Cache-Control', 'no-store');
  context.header('Referrer-Policy', 'no-referrer');
}

/** A launch grants only a test, whose identity must be separately confirmed before linking/enabling. */
export async function createLoginTestLaunch(
  context: Context<ApiEnv>,
  actor: AuthenticationActor,
  connectionId: string,
): Promise<{ id: string; url: string; expiresAt: string }> {
  const db = context.get('db');
  const connection = await readLoginConnection(db, connectionId);
  if (
    !connection ||
    !(await validateHumanSession(
      db,
      { sub: actor.userId, aud: actor.audience, sid: actor.sessionId },
      actor.companyIdentity,
    ))
  ) {
    throw new AuthenticationConfigurationError(
      'Sign in again before testing a login method.',
      'reauthentication_required',
      401,
    );
  }
  const id = `test.${crypto.randomUUID()}`;
  const proof = crypto.randomUUID() + crypto.randomUUID();
  const expiresAt = new Date(Date.now() + FLOW_SECONDS * 1000).toISOString();
  await db.insert(platformAuthAttempts).values({
    id,
    connection_id: connectionId,
    revision: connection.revision,
    generation: connection.generation,
    purpose: 'test',
    browser_hash: await hashLoginProof(proof),
    context: { phase: 'launch', actor, companyIdentity: actor.companyIdentity },
    expires_at: expiresAt,
  });
  const url = new URL('/auth/test', context.req.url);
  url.searchParams.set('id', id);
  url.searchParams.set('proof', proof);
  return { id, url: url.href, expiresAt };
}

export async function startLoginTest(context: Context<ApiEnv>): Promise<Response> {
  try {
    const db = context.get('db');
    const id = context.req.query('id');
    const proof = context.req.query('proof');
    if (!id || !proof) {
      throw new Error('Missing test launch');
    }
    const [launch] = await db
      .delete(platformAuthAttempts)
      .where(
        and(
          eq(platformAuthAttempts.id, id),
          eq(platformAuthAttempts.purpose, 'test'),
          eq(platformAuthAttempts.browser_hash, await hashLoginProof(proof)),
          gt(platformAuthAttempts.expires_at, new Date().toISOString()),
        ),
      )
      .returning();
    const saved = launch?.context as { phase?: string; actor?: AuthenticationActor } | undefined;
    const actor = saved?.actor;
    if (
      !launch ||
      saved?.phase !== 'launch' ||
      !actor ||
      !(await validateHumanSession(
        db,
        {
          sub: actor.userId,
          sid: actor.sessionId,
          aud: actor.audience,
        },
        context.get('companyIdentity'),
      ))
    ) {
      throw new Error('Invalid test launch');
    }
    const connection = await readLoginConnection(db, launch.connection_id);
    if (
      !connection ||
      connection.revision !== launch.revision ||
      connection.generation !== launch.generation
    ) {
      throw new Error('Configuration changed');
    }
    const revision = await readLoginRevision(db, connection.id, launch.revision);
    if (!revision) {
      throw new Error('Configuration missing');
    }
    const redirectUri =
      context.env.AUTH_REDIRECT_URI ?? new URL('/auth/callback', context.req.url).href;
    const state = `platform.${crypto.randomUUID()}`;
    const browserProof = crypto.randomUUID() + crypto.randomUUID();
    const authorization = await authorizationFor(revision.configuration, redirectUri, state);
    await db.insert(platformAuthAttempts).values({
      id: state,
      connection_id: connection.id,
      revision: launch.revision,
      generation: launch.generation,
      purpose: 'test',
      browser_hash: await hashLoginProof(browserProof),
      context: {
        redirect: '',
        redirectUri,
        verifier: authorization.verifier,
        nonce: authorization.nonce,
        actor,
        testId: launch.id,
        companyIdentity: context.get('companyIdentity'),
      },
      expires_at: launch.expires_at,
    });
    bindBrowser(context, browserProof);
    return context.redirect(authorization.url);
  } catch (error) {
    return authenticationError(context, error);
  }
}

/** Null means this installation still uses its existing deployment-time login configuration. */
export async function startPlatformLogin(
  context: Context<ApiEnv>,
  purpose: 'login' | 'admin',
  providerId?: string,
): Promise<Response | null> {
  const db = context.get('db');
  if (!(await readAuthSettings(db))) {
    return null;
  }
  try {
    const id = providerId ?? context.req.query('provider') ?? 'github';
    const connection = await readLoginConnection(db, id);
    if (!connection?.enabled || !connection.active_revision) {
      throw new AuthenticationConfigurationError(
        'This login method is unavailable.',
        'provider_unavailable',
        404,
      );
    }
    const revision = await readLoginRevision(db, id, connection.active_revision);
    if (!revision) {
      throw new Error('Missing active configuration');
    }
    const redirect = purpose === 'admin' ? '/admin/' : context.req.query('redirect');
    if (
      !redirect ||
      (purpose === 'login' &&
        !isAllowedRedirect(
          redirect,
          context.env.DASHBOARD_URL,
          context.env.PLATFORM_INSTALLATION_ID,
        ))
    ) {
      throw new AuthenticationConfigurationError(
        'A localhost or dashboard redirect is required.',
        'invalid_redirect',
        400,
      );
    }
    const redirectUri =
      context.env.AUTH_REDIRECT_URI ?? new URL('/auth/callback', context.req.url).href;
    const state = `platform.${crypto.randomUUID()}`;
    const browserProof = crypto.randomUUID() + crypto.randomUUID();
    const saved: LoginContext = {
      redirect,
      redirectUri,
      verifier: '',
      companyIdentity: context.get('companyIdentity'),
    };
    if (purpose === 'login' && isLocalhostRedirect(new URL(redirect))) {
      const cliState = new URL(redirect).searchParams.get('state');
      const challenge = context.req.query('code_challenge');
      if (
        !cliState ||
        !challenge ||
        !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
        context.req.query('code_challenge_method') !== 'S256'
      ) {
        throw new AuthenticationConfigurationError(
          'CLI login requires PKCE. Update the Void CLI and try again.',
          'pkce_required',
          400,
        );
      }
      saved.cliState = cliState;
      saved.codeChallenge = challenge;
    }
    const authorization = await authorizationFor(revision.configuration, redirectUri, state);
    saved.verifier = authorization.verifier;
    saved.nonce = authorization.nonce;
    await db.insert(platformAuthAttempts).values({
      id: state,
      connection_id: id,
      revision: connection.active_revision,
      generation: connection.generation,
      purpose,
      browser_hash: await hashLoginProof(browserProof),
      context: saved,
      expires_at: new Date(Date.now() + FLOW_SECONDS * 1000).toISOString(),
    });
    bindBrowser(context, browserProof);
    return context.redirect(authorization.url);
  } catch (error) {
    return authenticationError(context, error);
  }
}

export async function completePlatformLogin(context: Context<ApiEnv>): Promise<Response> {
  const db = context.get('db');
  try {
    const state = context.req.query('state');
    const browserProof = getCookie(context, COOKIE);
    if (!state || !browserProof) {
      throw new AuthenticationConfigurationError(
        'The login browser session is missing.',
        'invalid_state',
        400,
      );
    }
    const [attempt] = await db
      .delete(platformAuthAttempts)
      .where(
        and(
          eq(platformAuthAttempts.id, state),
          eq(platformAuthAttempts.browser_hash, await hashLoginProof(browserProof)),
          gt(platformAuthAttempts.expires_at, new Date().toISOString()),
        ),
      )
      .returning();
    if (
      !attempt ||
      (attempt.purpose !== 'login' && attempt.purpose !== 'admin' && attempt.purpose !== 'test')
    ) {
      throw new AuthenticationConfigurationError(
        'The login attempt expired or was already used.',
        'invalid_state',
        400,
      );
    }
    deleteCookie(context, COOKIE, { path: '/auth/callback' });
    const saved = attempt.context as LoginContext;
    const currentCompany = context.get('companyIdentity');
    if (
      saved.companyIdentity?.issuer !== currentCompany?.issuer ||
      saved.companyIdentity?.subject !== currentCompany?.subject
    ) {
      throw new AuthenticationConfigurationError(
        'The company identity changed during login.',
        'company_identity_changed',
        403,
      );
    }
    const connection = await readLoginConnection(db, attempt.connection_id);
    if (
      !connection ||
      (attempt.purpose !== 'test' && !connection.enabled) ||
      (attempt.purpose === 'test' ? connection.revision : connection.active_revision) !==
        attempt.revision ||
      connection.generation !== attempt.generation
    ) {
      throw new AuthenticationConfigurationError(
        'The login method changed. Start a new login.',
        'login_changed',
        401,
      );
    }
    const revision = await readLoginRevision(db, connection.id, attempt.revision);
    if (!revision) {
      throw new Error('Missing login configuration');
    }
    const secret = await readLoginSecret(context.env, revision);
    let identity: PlatformOidcIdentity;
    if (connection.kind === 'github') {
      const code = context.req.query('code');
      if (!code || context.req.query('error')) {
        throw new Error('GitHub login failed');
      }
      const token = await exchangeCodeForToken(
        revision.configuration.clientId,
        secret,
        code,
        saved.redirectUri,
        saved.verifier,
      );
      const user = await getGitHubUser(token);
      identity = {
        issuer: 'https://github.com',
        subject: String(user.id),
        login: user.login,
        email: user.email,
        emailVerified: user.emailVerified,
        groups: [],
      };
    } else {
      if (!saved.nonce) {
        throw new Error('Missing OIDC nonce');
      }
      identity = await oidcProvider(revision.configuration).exchange({
        callback: new URL(context.req.url),
        redirectUri: saved.redirectUri,
        state,
        verifier: saved.verifier,
        nonce: saved.nonce,
        clientSecret: secret,
      });
    }
    if (attempt.purpose === 'test') {
      await db.transaction(async (transaction) => {
        const tx = transaction as unknown as Db;
        await lockAuthSettings(tx);
        const latest = await readLoginConnection(tx, connection.id);
        const actor = saved.actor;
        if (
          !actor ||
          !saved.testId ||
          !latest ||
          latest.revision !== attempt.revision ||
          latest.generation !== attempt.generation ||
          !(await validateHumanSession(
            tx,
            { sub: actor.userId, sid: actor.sessionId, aud: actor.audience },
            currentCompany,
          ))
        ) {
          throw new AuthenticationConfigurationError(
            'The test or administrator session changed. Start a new test.',
            'login_changed',
            401,
          );
        }
        await tx.insert(platformLoginTests).values({
          id: saved.testId,
          user_id: actor.userId,
          connection_id: connection.id,
          revision: attempt.revision,
          issuer: identity.issuer,
          subject: identity.subject,
          expires_at: new Date(Date.now() + FLOW_SECONDS * 1000).toISOString(),
        });
      });
      context.header('Cache-Control', 'no-store');
      context.header('Referrer-Policy', 'no-referrer');
      return context.html(
        '<!doctype html><title>Void login test</title><p>Login verified. Return to Void to review the identity and finish configuration.</p>',
      );
    }
    const { user } = await resolvePlatformLogin(
      db,
      context.env,
      { connectionId: connection.id, revision: attempt.revision, generation: attempt.generation },
      identity,
      currentCompany,
    );
    const audience = attempt.purpose === 'admin' ? 'admin' : 'api';
    const { token, session } = await createHumanSession(db, context.env.JWT_SECRET, {
      userId: user.id,
      connectionId: connection.id,
      revision: attempt.revision,
      generation: attempt.generation,
      audience,
      companyIdentity: currentCompany,
    });
    context.header('Cache-Control', 'no-store');
    if (audience === 'admin') {
      setCookie(context, 'admin_token', token, {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/',
        maxAge: Math.max(0, Math.floor((Date.parse(session.expires_at) - Date.now()) / 1000)),
      });
      return context.redirect('/admin/');
    }
    if (
      !isAllowedRedirect(
        saved.redirect,
        context.env.DASHBOARD_URL,
        context.env.PLATFORM_INSTALLATION_ID,
      )
    ) {
      throw new Error('Login redirect no longer allowed');
    }
    const redirect = new URL(saved.redirect);
    const code = crypto.randomUUID();
    if (isLocalhostRedirect(redirect)) {
      if (!saved.codeChallenge || !saved.cliState) {
        throw new Error('Missing CLI proof');
      }
      await storeAuthCode(db, code, token, 300, {
        cliState: saved.cliState,
        codeChallenge: saved.codeChallenge,
        codeChallengeMethod: 'S256',
      });
    } else {
      await storeAuthCode(db, code, token, 300);
    }
    redirect.searchParams.delete('token');
    redirect.searchParams.set('code', code);
    return context.redirect(redirect.href);
  } catch (error) {
    return authenticationError(context, error);
  }
}
