import {
  parsePlatformAccessProtection,
  parsePlatformAdmissionPolicy,
  validatePlatformAdmissionPolicy,
} from '@void/platform';
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { createOAuthAccount, getUserByOAuthAccount, type Db } from '../db.ts';
import {
  oauthAccounts,
  operatorSessions,
  platformAuthSettings,
  platformLoginConnections,
  platformLoginIdentities,
  platformLoginTests,
  users,
} from '../schema.ts';
import { isAdminSuspended } from '../suspension.ts';
import {
  AuthenticationConfigurationError,
  lockAuthSettings,
  readEnabledLoginConnections,
  readLoginConnection,
  readLoginRevision,
} from './configuration.ts';
import {
  revokeConnectionSessions,
  validateHumanSession,
  type CompanyIdentity,
} from './sessions.ts';

export type AuthenticationActor = Readonly<{
  userId: string;
  sessionId: string;
  audience: 'api' | 'admin';
  companyIdentity?: CompanyIdentity;
}>;

async function requireActor(db: Db, actor: AuthenticationActor, admin: boolean): Promise<void> {
  if (
    !actor.sessionId ||
    !(await validateHumanSession(
      db,
      {
        sub: actor.userId,
        aud: actor.audience,
        sid: actor.sessionId,
      },
      actor.companyIdentity,
    ))
  ) {
    throw new AuthenticationConfigurationError(
      'Sign in again before changing authentication settings.',
      'reauthentication_required',
      401,
    );
  }
  const [user] = await db.select().from(users).where(eq(users.id, actor.userId));
  if (!user || isAdminSuspended(user.suspended_reason) || (admin && user.role !== 'admin')) {
    throw new AuthenticationConfigurationError(
      'An active administrator is required.',
      'forbidden',
      403,
    );
  }
}

async function freshTest(
  db: Db,
  actor: AuthenticationActor,
  testId: string,
  id: string,
  revision: number,
) {
  const [test] = await db
    .select()
    .from(platformLoginTests)
    .where(
      and(
        eq(platformLoginTests.id, testId),
        eq(platformLoginTests.user_id, actor.userId),
        eq(platformLoginTests.connection_id, id),
        eq(platformLoginTests.revision, revision),
        gt(platformLoginTests.expires_at, new Date().toISOString()),
      ),
    );
  if (!test) {
    throw new AuthenticationConfigurationError(
      'Test this exact login configuration again before enabling or linking it.',
      'login_test_required',
    );
  }
  return test;
}

async function hasVerifiedAlternative(
  db: Db,
  actor: AuthenticationActor,
  excludedId: string,
): Promise<boolean> {
  const verified = await db
    .select({ id: platformLoginIdentities.id })
    .from(platformLoginIdentities)
    .innerJoin(
      platformLoginConnections,
      eq(platformLoginConnections.id, platformLoginIdentities.connection_id),
    )
    .innerJoin(
      platformLoginTests,
      and(
        eq(platformLoginTests.connection_id, platformLoginConnections.id),
        eq(platformLoginTests.revision, platformLoginConnections.active_revision),
        eq(platformLoginTests.user_id, platformLoginIdentities.user_id),
        eq(platformLoginTests.issuer, platformLoginIdentities.issuer),
        eq(platformLoginTests.subject, platformLoginIdentities.subject),
      ),
    )
    .where(
      and(
        eq(platformLoginIdentities.user_id, actor.userId),
        ne(platformLoginConnections.id, excludedId),
        eq(platformLoginConnections.enabled, true),
        gt(platformLoginTests.expires_at, new Date().toISOString()),
      ),
    )
    .limit(1);
  return verified.length > 0;
}

/** Explicitly confirmed linking; a successful provider test alone never merges accounts. */
export async function linkTestedIdentity(
  db: Db,
  actor: AuthenticationActor,
  input: {
    connectionId: string;
    revision: number;
    testId: string;
  },
): Promise<void> {
  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await lockAuthSettings(tx);
    await requireActor(tx, actor, false);
    const connection = await readLoginConnection(tx, input.connectionId);
    if (!connection || connection.revision !== input.revision) {
      throw new AuthenticationConfigurationError(
        'Login settings changed. Reload before linking.',
        'revision_conflict',
      );
    }
    const test = await freshTest(tx, actor, input.testId, connection.id, connection.revision);
    const [subjectOwner] = await tx
      .select()
      .from(platformLoginIdentities)
      .where(
        and(
          eq(platformLoginIdentities.connection_id, connection.id),
          eq(platformLoginIdentities.issuer, test.issuer),
          eq(platformLoginIdentities.subject, test.subject),
        ),
      );
    const [userIdentity] = await tx
      .select()
      .from(platformLoginIdentities)
      .where(
        and(
          eq(platformLoginIdentities.connection_id, connection.id),
          eq(platformLoginIdentities.user_id, actor.userId),
        ),
      );
    if (
      (subjectOwner && subjectOwner.user_id !== actor.userId) ||
      (userIdentity &&
        (userIdentity.issuer !== test.issuer || userIdentity.subject !== test.subject))
    ) {
      throw new AuthenticationConfigurationError(
        'This login identity is already linked to another account.',
        'identity_conflict',
      );
    }
    if (!subjectOwner) {
      if (connection.kind === 'github' || connection.kind === 'google') {
        const existing = await getUserByOAuthAccount(tx, connection.kind, test.subject);
        const [previous] = await tx
          .select()
          .from(oauthAccounts)
          .where(
            and(
              eq(oauthAccounts.user_id, actor.userId),
              eq(oauthAccounts.provider, connection.kind),
            ),
          );
        if (
          (existing && existing.id !== actor.userId) ||
          (previous && previous.provider_id !== test.subject)
        ) {
          throw new AuthenticationConfigurationError(
            'This provider is already linked to a different identity.',
            'identity_conflict',
          );
        }
        if (!existing) {
          await createOAuthAccount(tx, actor.userId, connection.kind, test.subject);
        }
      }
      await tx.insert(platformLoginIdentities).values({
        id: crypto.randomUUID(),
        user_id: actor.userId,
        connection_id: connection.id,
        issuer: test.issuer,
        subject: test.subject,
      });
    }
  });
}

export async function enableLoginConnection(
  db: Db,
  actor: AuthenticationActor,
  input: {
    connectionId: string;
    revision: number;
    testId: string;
  },
): Promise<void> {
  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const settings = await lockAuthSettings(tx);
    await requireActor(tx, actor, true);
    const connection = await readLoginConnection(tx, input.connectionId);
    if (!settings || !connection || connection.revision !== input.revision) {
      throw new AuthenticationConfigurationError(
        'Login settings changed. Reload before enabling.',
        'revision_conflict',
      );
    }
    if (connection.enabled && connection.active_revision === connection.revision) {
      return;
    }
    const test = await freshTest(tx, actor, input.testId, connection.id, connection.revision);
    const revision = await readLoginRevision(tx, connection.id, connection.revision);
    if (!revision) {
      throw new AuthenticationConfigurationError('Missing tested configuration.');
    }
    const enabled = await readEnabledLoginConnections(tx);
    const alternative = enabled.filter((row) => row.connection.id !== connection.id);
    if (connection.enabled && !(await hasVerifiedAlternative(tx, actor, connection.id))) {
      const [linked] = await tx
        .select()
        .from(platformLoginIdentities)
        .where(
          and(
            eq(platformLoginIdentities.user_id, actor.userId),
            eq(platformLoginIdentities.connection_id, connection.id),
            eq(platformLoginIdentities.issuer, test.issuer),
            eq(platformLoginIdentities.subject, test.subject),
          ),
        );
      if (!linked) {
        throw new AuthenticationConfigurationError(
          'Link your tested identity before replacing the last login method.',
          'last_admin_login',
        );
      }
    }
    validatePlatformAdmissionPolicy(
      parsePlatformAdmissionPolicy(settings.admission),
      [...alternative.map((row) => row.configuration), revision.configuration],
      parsePlatformAccessProtection(settings.protection),
    );
    await revokeConnectionSessions(tx, connection.id);
    await tx
      .update(platformLoginConnections)
      .set({ enabled: true, active_revision: connection.revision })
      .where(eq(platformLoginConnections.id, connection.id));
    await tx
      .update(platformAuthSettings)
      .set({ revision: sql`${platformAuthSettings.revision} + 1`, sessions_required: true });
    await tx.delete(operatorSessions).where(isNull(operatorSessions.human_session_id));
  });
}

export async function disableLoginConnection(
  db: Db,
  actor: AuthenticationActor,
  input: {
    connectionId: string;
    revision: number;
  },
): Promise<void> {
  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const settings = await lockAuthSettings(tx);
    await requireActor(tx, actor, true);
    const connection = await readLoginConnection(tx, input.connectionId);
    if (!settings || !connection || connection.revision !== input.revision) {
      throw new AuthenticationConfigurationError(
        'Login settings changed. Reload before disabling.',
        'revision_conflict',
      );
    }
    if (!connection.enabled) {
      return;
    }
    const remaining = (await readEnabledLoginConnections(tx)).filter(
      (row) => row.connection.id !== connection.id,
    );
    if (remaining.length === 0) {
      throw new AuthenticationConfigurationError(
        'The last login method cannot be disabled.',
        'last_login_method',
      );
    }
    if (!(await hasVerifiedAlternative(tx, actor, connection.id))) {
      throw new AuthenticationConfigurationError(
        'Sign in or test a linked alternative login method before disabling this one.',
        'alternative_login_required',
      );
    }
    validatePlatformAdmissionPolicy(
      parsePlatformAdmissionPolicy(settings.admission),
      remaining.map((row) => row.configuration),
      parsePlatformAccessProtection(settings.protection),
    );
    await tx
      .update(platformLoginConnections)
      .set({ enabled: false })
      .where(eq(platformLoginConnections.id, connection.id));
    await revokeConnectionSessions(tx, connection.id);
    await tx
      .update(platformAuthSettings)
      .set({ revision: sql`${platformAuthSettings.revision} + 1`, sessions_required: true });
    await tx.delete(operatorSessions).where(isNull(operatorSessions.human_session_id));
  });
}
