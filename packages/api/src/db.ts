import {
  and,
  count,
  desc,
  asc,
  eq,
  ne,
  inArray,
  notInArray,
  ilike,
  isNotNull,
  isNull,
  or,
  sql,
  getTableColumns,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import { generateId } from './id';
import * as schema from './schema';
import {
  users,
  oauthAccounts,
  projects,
  deployments,
  projectSecrets,
  resources,
  domains,
  platformEvents,
  invitations,
  oauthNonces,
  authCodes,
  migrationRenames,
} from './schema';
import type { PlanId } from './tiers';
import type {
  Deployment,
  DeploymentStatus,
  Domain,
  Invitation,
  OAuthAccount,
  PlatformEvent,
  ProjectSecret,
  Project,
  Resource,
  User,
} from './types';

export function createDb(connectionString: string) {
  return drizzle(connectionString, { schema });
}
export type Db = ReturnType<typeof createDb>;

export const TERMINAL_DEPLOYMENT_STATUSES: DeploymentStatus[] = ['live', 'failed', 'canceled'];
export const CANCELLATION_REQUESTED_DEPLOYMENT_STATUSES: DeploymentStatus[] = [
  'canceling',
  'canceled',
];

// --- Users ---

export async function createUser(
  db: Db,
  provider: string,
  providerId: string,
  login: string,
  email: string | null,
): Promise<User> {
  const id = generateId('user');
  const [row] = await db
    .insert(users)
    .values({ id, provider, provider_id: providerId, login, email })
    .returning();
  return row;
}

export async function getUserByProvider(
  db: Db,
  provider: string,
  providerId: string,
): Promise<User | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(and(eq(users.provider, provider), eq(users.provider_id, providerId)))
    .limit(1);
  return row ?? null;
}

export async function getUserByEmail(db: Db, email: string): Promise<User | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1);
  return row ?? null;
}

export async function getUser(db: Db, id: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

export async function updateUser(
  db: Db,
  id: string,
  login: string,
  email: string | null,
): Promise<void> {
  await db.update(users).set({ login, email }).where(eq(users.id, id));
}

// --- OAuth Accounts ---

export async function getUserByOAuthAccount(
  db: Db,
  provider: string,
  providerId: string,
): Promise<User | null> {
  const [row] = await db
    .select({ user: users })
    .from(oauthAccounts)
    .innerJoin(users, eq(oauthAccounts.user_id, users.id))
    .where(and(eq(oauthAccounts.provider, provider), eq(oauthAccounts.provider_id, providerId)))
    .limit(1);
  return row?.user ?? null;
}

export async function createOAuthAccount(
  db: Db,
  userId: string,
  provider: string,
  providerId: string,
): Promise<OAuthAccount> {
  const id = generateId('oa');
  const [row] = await db
    .insert(oauthAccounts)
    .values({ id, user_id: userId, provider, provider_id: providerId })
    .returning();
  return row;
}

export async function updateUserPlan(db: Db, id: string, plan: PlanId): Promise<void> {
  await db.update(users).set({ plan }).where(eq(users.id, id));
}

export async function countUserDeploymentsToday(db: Db, userId: string): Promise<number> {
  const [result] = await db
    .select({ count: count() })
    .from(deployments)
    .innerJoin(projects, eq(deployments.project_id, projects.id))
    .where(and(eq(projects.user_id, userId), sql`${deployments.created_at} >= CURRENT_DATE`));
  return result?.count ?? 0;
}

// --- Projects ---

export async function createProject(db: Db, userId: string, slug: string): Promise<Project> {
  const id = generateId('proj');
  const [row] = await db.insert(projects).values({ id, user_id: userId, slug }).returning();
  return row;
}

export async function getProject(db: Db, id: string): Promise<Project | null> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return row ?? null;
}

export async function getProjectBySlug(db: Db, slug: string): Promise<Project | null> {
  const [row] = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
  return row ?? null;
}

export async function getProjectsByUserId(db: Db, userId: string): Promise<Project[]> {
  return db
    .select()
    .from(projects)
    .where(eq(projects.user_id, userId))
    .orderBy(desc(projects.created_at));
}

export async function getProjectsWithOwnerByIds(
  db: Db,
  ids: string[],
): Promise<
  (Project & {
    owner_login: string | null;
  })[]
> {
  if (ids.length === 0) {
    return [];
  }

  return db
    .select({
      ...getTableColumns(projects),
      owner_login: users.login,
    })
    .from(projects)
    .leftJoin(users, eq(projects.user_id, users.id))
    .where(inArray(projects.id, ids));
}

export async function updateProjectType(db: Db, id: string, type: Project['type']): Promise<void> {
  await db.update(projects).set({ type }).where(eq(projects.id, id));
}

export async function updateProjectWebSocketVersion(
  db: Db,
  id: string,
  websocketVersion: number,
): Promise<void> {
  await db.update(projects).set({ websocket_version: websocketVersion }).where(eq(projects.id, id));
}

// --- Deployments ---

export async function createDeployment(
  db: Db,
  projectId: string,
  manifest: string | null,
  source?: string | null,
  commit?: string | null,
): Promise<Deployment> {
  const id = generateId('dpl');
  const [row] = await db
    .insert(deployments)
    .values({
      id,
      project_id: projectId,
      manifest,
      source: source ?? null,
      commit: commit ?? null,
    })
    .returning();
  return row;
}

export async function updateDeploymentStatus(
  db: Db,
  id: string,
  status: Deployment['status'],
  errorMessage?: string,
  options?: { force?: boolean },
): Promise<void> {
  await db
    .update(deployments)
    .set({
      status,
      updated_at: sql`now()`,
      deployed_at:
        status === 'live'
          ? sql`COALESCE(${deployments.deployed_at}, now())`
          : sql`${deployments.deployed_at}`,
      error_message: sql`COALESCE(${errorMessage ?? null}, ${deployments.error_message})`,
    })
    .where(
      options?.force
        ? eq(deployments.id, id)
        : and(
            eq(deployments.id, id),
            notInArray(deployments.status, CANCELLATION_REQUESTED_DEPLOYMENT_STATUSES),
          ),
    );
}

export async function getDeployment(db: Db, id: string): Promise<Deployment | null> {
  const [row] = await db.select().from(deployments).where(eq(deployments.id, id)).limit(1);
  return row ?? null;
}

export async function getProjectDeployments(
  db: Db,
  projectId: string,
  limit = 5,
): Promise<Deployment[]> {
  return db
    .select()
    .from(deployments)
    .where(eq(deployments.project_id, projectId))
    .orderBy(desc(deployments.created_at))
    .limit(limit);
}

export async function getAllProjectDeployments(db: Db, projectId: string): Promise<Deployment[]> {
  return db
    .select()
    .from(deployments)
    .where(eq(deployments.project_id, projectId))
    .orderBy(desc(deployments.created_at));
}

export async function getAllDeploymentsWithProject(
  db: Db,
  limit: number,
  offset: number,
): Promise<(Deployment & { project_slug: string | null; active_deployment_id: string | null })[]> {
  return db
    .select({
      ...getTableColumns(deployments),
      project_slug: projects.slug,
      active_deployment_id: projects.active_deployment_id,
    })
    .from(deployments)
    .leftJoin(projects, eq(deployments.project_id, projects.id))
    .orderBy(desc(deployments.created_at))
    .limit(limit)
    .offset(offset);
}

export async function countDeployments(db: Db): Promise<number> {
  const [result] = await db.select({ count: count() }).from(deployments);
  return result?.count ?? 0;
}

export async function failStaleDeployments(db: Db): Promise<number> {
  const result = await db
    .update(deployments)
    .set({
      status: 'failed',
      updated_at: sql`now()`,
      error_message: sql`COALESCE(${deployments.error_message}, 'timed out')`,
    })
    .where(
      and(
        notInArray(deployments.status, TERMINAL_DEPLOYMENT_STATUSES),
        sql`${deployments.updated_at} < now() - interval '30 minutes'`,
      ),
    );
  return result.rowCount ?? 0;
}

export async function getActiveDeployment(db: Db, projectId: string): Promise<Deployment | null> {
  const [row] = await db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.project_id, projectId),
        notInArray(deployments.status, TERMINAL_DEPLOYMENT_STATUSES),
      ),
    )
    .orderBy(desc(deployments.created_at))
    .limit(1);
  return row ?? null;
}

export async function cancelDeployment(
  db: Db,
  deploymentId: string,
  errorMessage = 'canceled',
): Promise<Deployment | null> {
  const [row] = await db
    .update(deployments)
    .set({
      status: 'canceling',
      updated_at: sql`now()`,
      error_message: sql`COALESCE(${deployments.error_message}, ${errorMessage})`,
    })
    .where(
      and(
        eq(deployments.id, deploymentId),
        notInArray(deployments.status, TERMINAL_DEPLOYMENT_STATUSES),
      ),
    )
    .returning();
  return row ?? null;
}

export async function getLastLiveAssetManifest(
  db: Db,
  projectId: string,
): Promise<Record<string, { hash: string; size: number }> | null> {
  const [row] = await db
    .select({ asset_hashes: deployments.asset_hashes })
    .from(deployments)
    .where(and(eq(deployments.project_id, projectId), eq(deployments.status, 'live')))
    .orderBy(desc(deployments.created_at))
    .limit(1);

  if (!row?.asset_hashes) {
    return null;
  }
  return JSON.parse(row.asset_hashes);
}

export async function setActiveDeployment(
  db: Db,
  projectId: string,
  deploymentId: string,
): Promise<void> {
  await db
    .update(projects)
    .set({ active_deployment_id: deploymentId })
    .where(eq(projects.id, projectId));
}

export async function markDeploymentRetained(
  db: Db,
  deploymentId: string,
  retained: boolean,
): Promise<void> {
  await db.update(deployments).set({ retained }).where(eq(deployments.id, deploymentId));
}

export async function setAppliedMigrations(
  db: Db,
  deploymentId: string,
  migrations: string[],
): Promise<void> {
  await db
    .update(deployments)
    .set({ applied_migrations: JSON.stringify(migrations) })
    .where(eq(deployments.id, deploymentId));
}

/**
 * Atomically append newly-applied migration names to a deployment's
 * applied_migrations JSON text column, de-duping against what's already there.
 *
 * The previous read/merge/write pattern (fetch, JSON.parse, union, stringify,
 * UPDATE) lost entries under concurrent POST /migrations/apply requests: two
 * callers could both see the same pre-merge state and each overwrite with
 * their own partial union. Wrapping the read-then-write in a SERIALIZABLE
 * transaction with `SELECT … FOR UPDATE` serializes writers at the row level
 * so the second request waits for the first commit and observes its write.
 *
 * No-op when `newMigrations` is empty or the deployment row doesn't exist.
 */
export async function appendAppliedMigrations(
  db: Db,
  deploymentId: string,
  newMigrations: string[],
): Promise<void> {
  if (newMigrations.length === 0) {
    return;
  }
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ applied_migrations: deployments.applied_migrations })
      .from(deployments)
      .where(eq(deployments.id, deploymentId))
      .for('update');
    if (rows.length === 0) {
      return;
    }
    const existing: string[] = rows[0]!.applied_migrations
      ? JSON.parse(rows[0]!.applied_migrations)
      : [];
    const existingSet = new Set(existing);
    const toAdd = newMigrations.filter((m) => !existingSet.has(m));
    if (toAdd.length === 0) {
      return;
    }
    const merged = [...existing, ...toAdd];
    await tx
      .update(deployments)
      .set({ applied_migrations: JSON.stringify(merged) })
      .where(eq(deployments.id, deploymentId));
  });
}

/**
 * Check whether the CURRENT active deployment of a project has `migrationName`
 * present in its `applied_migrations` JSON array. Used by the rename endpoint
 * to corroborate ambiguous `!fromExists && toExists` classifications against
 * pg before rewriting metadata — a legitimate idempotent retry of a rename
 * that landed in D1 but failed to commit to pg will still reference the old
 * name on the active deployment.
 *
 * Scoped to the active deployment only. Stale retained deployment rows from
 * pre-R6 (when /migrations/rename only updated the active deployment's
 * `applied_migrations`) could be historically inaccurate and would silently
 * authorize incorrect rename requests that happen to name a
 * historically-present migration. The active deployment is the only source
 * of truth we can rely on for corroboration.
 *
 * The column is stored as text (see `setAppliedMigrations`), so the query
 * casts at read time. `jsonb ? text` returns true iff the JSON array has
 * `migrationName` as a top-level element.
 */
export async function activeDeploymentContainsMigration(
  db: Db,
  projectId: string,
  migrationName: string,
): Promise<boolean> {
  const result = (await db.execute(sql`
    SELECT 1
    FROM ${projects}
    INNER JOIN ${deployments} ON ${deployments.id} = ${projects.active_deployment_id}
    WHERE ${projects.id} = ${projectId}
      AND ${deployments.applied_migrations} IS NOT NULL
      AND (${deployments.applied_migrations})::jsonb ? ${migrationName}
    LIMIT 1
  `)) as { rows: unknown[] };
  return result.rows.length > 0;
}

/**
 * Rewrite `applied_migrations` entries across every deployment of a project.
 *
 * The rename endpoint updates remote `_void_migrations` rows in D1 and must
 * also keep the platform-side record consistent. A previous implementation
 * only rewrote the active deployment's `applied_migrations`, which left
 * retained and inactive deployments pointing at the old migration names and
 * broke rollback diffs that compare `applied_migrations` arrays. Rewriting
 * every project deployment in one transaction keeps all rows in sync.
 */
export async function renameAppliedMigrationsForProject(
  db: Db,
  projectId: string,
  renames: { from: string; to: string }[],
): Promise<void> {
  if (renames.length === 0) {
    return;
  }
  const fromToMap = new Map(renames.map((r) => [r.from, r.to]));
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: deployments.id, applied_migrations: deployments.applied_migrations })
      .from(deployments)
      .where(eq(deployments.project_id, projectId))
      .for('update');
    for (const row of rows) {
      if (!row.applied_migrations) {
        continue;
      }
      const parsed: string[] = JSON.parse(row.applied_migrations);
      let changed = false;
      const next = parsed.map((m) => {
        const to = fromToMap.get(m);
        if (to !== undefined) {
          changed = true;
          return to;
        }
        return m;
      });
      if (changed) {
        await tx
          .update(deployments)
          .set({ applied_migrations: JSON.stringify(next) })
          .where(eq(deployments.id, row.id));
      }
    }
  });
}

/**
 * Append committed /migrations/rename pairs to the audit log.
 *
 * The /rename partial-failure heal writes pg's `applied_migrations` before
 * surfacing a later pair's failure, which erases
 * `activeDeploymentContainsMigration(from)` as a corroboration source for
 * same-payload retries of an already-committed prefix. This audit log is
 * the durable, rename-specific second corroboration source:
 * `migrationRenameExists(project_id, from, to)` returning true means the
 * exact pair was already committed here in a previous locked tx, so an
 * idempotent retry must NOT be rejected as ambiguous.
 *
 * Called from the /rename handler inside the same locked tx as
 * `renameAppliedMigrationsForProject`, after every successful/idempotent
 * pair has been folded into `committed`. Uses ON CONFLICT DO NOTHING so
 * retries (and already-landed pairs from prior runs that land here again)
 * are no-ops. Note: the primary key is `(project_id, from_name, to_name)`
 * so this dedupes by the exact tuple — we never overwrite an existing row.
 */
export async function recordMigrationRenames(
  db: Db,
  projectId: string,
  pairs: { from: string; to: string }[],
): Promise<void> {
  if (pairs.length === 0) {
    return;
  }
  await db
    .insert(migrationRenames)
    .values(pairs.map((p) => ({ project_id: projectId, from_name: p.from, to_name: p.to })))
    .onConflictDoNothing();
}

/**
 * Returns true iff a committed rename from `from` to `to` has been recorded
 * for the given project. See `recordMigrationRenames` for the rationale.
 */
export async function migrationRenameExists(
  db: Db,
  projectId: string,
  from: string,
  to: string,
): Promise<boolean> {
  const [row] = await db
    .select({ project_id: migrationRenames.project_id })
    .from(migrationRenames)
    .where(
      and(
        eq(migrationRenames.project_id, projectId),
        eq(migrationRenames.from_name, from),
        eq(migrationRenames.to_name, to),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Invalidate stale `migration_renames` rows whose `to_name` matches a
 * migration that is now being renamed AWAY.
 *
 * Migration names can be recycled: if `(a, a1)` is logged, then `a1` is
 * later renamed to `b`, then a different migration `x` is renamed INTO
 * `a1`, the original `(a, a1)` row is stale. A fat-fingered retry of
 * `a → a1` would then pass the classifier on corroborated-by-audit
 * grounds even though `a1` now represents `x`'s migration, not `a`'s
 * lineage — silently rewriting any retained-deployment rows that still
 * mention `a`.
 *
 * Invariant: whenever we record a new rename X→Y, delete any prior
 * `migration_renames` rows where `to_name = X`. Rationale: those rows
 * assume X is still the canonical landing spot, but X is now being
 * renamed away, so their "landed at X" claim is no longer valid.
 *
 * Only `to_name` is invalidated, not `from_name`. If the user previously
 * renamed `a → a1` and now renames `a → a2`, both intents should remain
 * auditable. The stale-lineage issue is specifically about a previously
 * logged LANDING being recycled as a new SOURCE.
 *
 * Must be called inside the same locked tx as `recordMigrationRenames`
 * and `renameAppliedMigrationsForProject` so a rollback also rolls back
 * the invalidation.
 */
export async function invalidateMigrationRenamesForOldName(
  db: Db,
  projectId: string,
  oldName: string,
): Promise<void> {
  await db
    .delete(migrationRenames)
    .where(and(eq(migrationRenames.project_id, projectId), eq(migrationRenames.to_name, oldName)));
}

export async function getRetainedDeployments(db: Db, projectId: string): Promise<Deployment[]> {
  return db
    .select()
    .from(deployments)
    .where(and(eq(deployments.project_id, projectId), eq(deployments.retained, true)))
    .orderBy(desc(deployments.created_at));
}

export async function getRetainedDeploymentsExcluding(
  db: Db,
  projectId: string,
  excludeId: string,
): Promise<Deployment[]> {
  return db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.project_id, projectId),
        eq(deployments.retained, true),
        ne(deployments.id, excludeId),
      ),
    )
    .orderBy(desc(deployments.created_at));
}

// Every deployment for this project that persisted an asset manifest. Used by
// WfP asset-session corroboration: a row with non-null asset_hashes reached
// successful `uploadAssetBuckets` for its backend. The caller also needs
// `manifest` to re-derive the storage backend — static/SPA and WfP both land
// `asset_hashes` in this column, but the bytes live in different stores
// (platform KV/R2 vs Cloudflare's WfP asset cache). Cross-backend hashes must
// not corroborate each other. `retained` is a lifecycle/retention signal and
// is intentionally not filtered — a deploy that died in migrations still
// carries a valid corroboration baseline for its own backend.
//
// Bounded by `ASSET_HASH_CORROBORATION_LIMIT` to keep the fully-materialized
// result set out of the 128 MiB Worker isolate budget. Deployment rows are
// never deleted outside of project deletion and `asset_hashes` is never
// cleared on retention eviction, so an unbounded query on an active
// CI/CD project would grow without limit. Recent rows are sufficient for
// corroboration — an omitted hash that is NOT present in the last N rows is
// almost certainly an asset the user hasn't touched in a long time, and
// refusing to corroborate it is the safer default.
export const ASSET_HASH_CORROBORATION_LIMIT = 100;
export async function getDeploymentsWithAssetHashes(
  db: Db,
  projectId: string,
): Promise<{ asset_hashes: string | null; manifest: string | null }[]> {
  return db
    .select({ asset_hashes: deployments.asset_hashes, manifest: deployments.manifest })
    .from(deployments)
    .where(and(eq(deployments.project_id, projectId), isNotNull(deployments.asset_hashes)))
    .orderBy(desc(deployments.created_at))
    .limit(ASSET_HASH_CORROBORATION_LIMIT);
}

export async function getInFlightDeploymentsExcluding(
  db: Db,
  projectId: string,
  excludeId?: string | null,
): Promise<Deployment[]> {
  return db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.project_id, projectId),
        notInArray(deployments.status, TERMINAL_DEPLOYMENT_STATUSES),
        excludeId ? ne(deployments.id, excludeId) : undefined,
      ),
    )
    .orderBy(desc(deployments.created_at));
}

/**
 * Every deployment that has ever reached `live` (deployed_at IS NOT NULL),
 * regardless of current retention. Used by the rollback queue sweep to
 * union every queue that was ever owned by an activated deployment.
 */
export async function getActivatedDeployments(db: Db, projectId: string): Promise<Deployment[]> {
  return db
    .select()
    .from(deployments)
    .where(and(eq(deployments.project_id, projectId), isNotNull(deployments.deployed_at)))
    .orderBy(desc(deployments.created_at));
}

/**
 * Deployments that reached a terminal non-success state without ever
 * activating (deployed_at IS NULL, status in 'failed' | 'canceled').
 * Union'd with getActivatedDeployments at rollback to catch `queue:<name>`
 * KV routes a failed deploy wrote before the routing flip.
 */
export async function getTerminalFailedDeployments(
  db: Db,
  projectId: string,
): Promise<Deployment[]> {
  return db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.project_id, projectId),
        isNull(deployments.deployed_at),
        inArray(deployments.status, ['failed', 'canceled']),
      ),
    )
    .orderBy(desc(deployments.created_at));
}

// --- Project secrets ---

export async function listProjectSecretNames(
  db: Db,
  projectId: string,
): Promise<Array<{ name: string }>> {
  return db
    .select({ name: projectSecrets.name })
    .from(projectSecrets)
    .where(eq(projectSecrets.project_id, projectId))
    .orderBy(asc(projectSecrets.name));
}

export async function getProjectSecret(
  db: Db,
  projectId: string,
  name: string,
): Promise<ProjectSecret | null> {
  const [row] = await db
    .select()
    .from(projectSecrets)
    .where(and(eq(projectSecrets.project_id, projectId), eq(projectSecrets.name, name)))
    .limit(1);
  return row ?? null;
}

export async function getProjectSecrets(db: Db, projectId: string): Promise<ProjectSecret[]> {
  return db
    .select()
    .from(projectSecrets)
    .where(eq(projectSecrets.project_id, projectId))
    .orderBy(asc(projectSecrets.name));
}

export async function upsertProjectSecret(
  db: Db,
  projectId: string,
  name: string,
  ciphertext: string,
  iv: string,
  keyVersion: string,
  managedReason: string | null = null,
): Promise<ProjectSecret> {
  const [row] = await db
    .insert(projectSecrets)
    .values({
      id: generateId('psc'),
      project_id: projectId,
      name,
      ciphertext,
      iv,
      key_version: keyVersion,
      managed_reason: managedReason,
    })
    .onConflictDoUpdate({
      target: [projectSecrets.project_id, projectSecrets.name],
      set: {
        ciphertext,
        iv,
        key_version: keyVersion,
        managed_reason: managedReason,
        updated_at: sql`now()`,
      },
    })
    .returning();
  return row;
}

export async function deleteProjectSecret(db: Db, projectId: string, name: string): Promise<void> {
  await db
    .delete(projectSecrets)
    .where(and(eq(projectSecrets.project_id, projectId), eq(projectSecrets.name, name)));
}

// --- Resources ---

export async function createResource(
  db: Db,
  projectId: string,
  type: Resource['type'],
  cfId: string,
  bindingName: string,
): Promise<Resource> {
  const id = generateId('res');
  const [row] = await db
    .insert(resources)
    .values({ id, project_id: projectId, type, cf_id: cfId, binding_name: bindingName })
    .returning();
  return row;
}

export async function getProjectResources(db: Db, projectId: string): Promise<Resource[]> {
  return db.select().from(resources).where(eq(resources.project_id, projectId));
}

export async function getResourceByBinding(
  db: Db,
  projectId: string,
  type: 'd1' | 'kv' | 'r2' | 'queue',
  bindingName: string,
): Promise<{ cf_id: string } | undefined> {
  return db
    .select({ cf_id: resources.cf_id })
    .from(resources)
    .where(
      and(
        eq(resources.project_id, projectId),
        eq(resources.type, type),
        eq(resources.binding_name, bindingName),
      ),
    )
    .then((rows) => rows[0]);
}

// --- Domains ---

export async function createDomain(
  db: Db,
  projectId: string,
  hostname: string,
  cfHostnameId: string,
): Promise<Domain> {
  const id = generateId('dom');
  const [row] = await db
    .insert(domains)
    .values({ id, project_id: projectId, hostname, cf_hostname_id: cfHostnameId })
    .returning();
  return row;
}

export async function getDomainsByProjectId(db: Db, projectId: string): Promise<Domain[]> {
  return db
    .select()
    .from(domains)
    .where(eq(domains.project_id, projectId))
    .orderBy(asc(domains.created_at));
}

export async function getDomainsByProjectIds(
  db: Db,
  projectIds: string[],
): Promise<Map<string, Domain[]>> {
  const allDomains = await db
    .select()
    .from(domains)
    .where(inArray(domains.project_id, projectIds))
    .orderBy(asc(domains.created_at));

  const map = new Map<string, Domain[]>();
  for (const d of allDomains) {
    const list = map.get(d.project_id) ?? [];
    list.push(d);
    map.set(d.project_id, list);
  }
  return map;
}

export async function getDomainByHostname(db: Db, hostname: string): Promise<Domain | null> {
  const [row] = await db.select().from(domains).where(eq(domains.hostname, hostname)).limit(1);
  return row ?? null;
}

export async function getDomain(db: Db, id: string): Promise<Domain | null> {
  const [row] = await db.select().from(domains).where(eq(domains.id, id)).limit(1);
  return row ?? null;
}

export async function updateDomainStatus(
  db: Db,
  id: string,
  status: Domain['status'],
): Promise<void> {
  await db.update(domains).set({ status }).where(eq(domains.id, id));
}

export async function deleteDomain(db: Db, id: string): Promise<void> {
  await db.delete(domains).where(eq(domains.id, id));
}

export async function deleteProjectDomains(db: Db, projectId: string): Promise<void> {
  await db.delete(domains).where(eq(domains.project_id, projectId));
}

// --- Deletion ---

export async function deleteProjectResources(db: Db, projectId: string): Promise<void> {
  await db.delete(resources).where(eq(resources.project_id, projectId));
}

export async function deleteProjectDeployments(db: Db, projectId: string): Promise<void> {
  await db.delete(deployments).where(eq(deployments.project_id, projectId));
}

export async function deleteProject(db: Db, id: string): Promise<void> {
  await db.delete(projects).where(eq(projects.id, id));
}

export async function deleteProjectCascade(db: Db, projectId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(domains).where(eq(domains.project_id, projectId));
    await tx.delete(resources).where(eq(resources.project_id, projectId));
    await tx.delete(projectSecrets).where(eq(projectSecrets.project_id, projectId));
    await tx.delete(deployments).where(eq(deployments.project_id, projectId));
    await tx.delete(projects).where(eq(projects.id, projectId));
  });
}

// --- Counts ---

export async function countUsers(db: Db): Promise<number> {
  const [result] = await db.select({ count: count() }).from(users);
  return result?.count ?? 0;
}

export async function countProjects(db: Db): Promise<number> {
  const [result] = await db.select({ count: count() }).from(projects);
  return result?.count ?? 0;
}

// --- Admin ---

export async function getAllUsers(db: Db, limit: number, offset: number): Promise<User[]> {
  return db.select().from(users).orderBy(desc(users.created_at)).limit(limit).offset(offset);
}

export async function searchUsers(db: Db, query: string): Promise<User[]> {
  const pattern = `%${query}%`;
  return db
    .select()
    .from(users)
    .where(or(ilike(users.login, pattern), ilike(users.email, pattern), ilike(users.id, pattern)))
    .orderBy(desc(users.created_at))
    .limit(50);
}

export async function getSystemStats(
  db: Db,
): Promise<{ users: number; projects: number; deployments: number }> {
  const [[u], [p], [d]] = await Promise.all([
    db.select({ count: count() }).from(users),
    db.select({ count: count() }).from(projects),
    db.select({ count: count() }).from(deployments),
  ]);
  return {
    users: u?.count ?? 0,
    projects: p?.count ?? 0,
    deployments: d?.count ?? 0,
  };
}

export async function suspendUser(db: Db, id: string, reason: string): Promise<void> {
  await db.update(users).set({ suspended_reason: reason }).where(eq(users.id, id));
}

export async function unsuspendUser(db: Db, id: string): Promise<void> {
  await db.update(users).set({ suspended_reason: null }).where(eq(users.id, id));
}

export async function updateUserRole(db: Db, id: string, role: 'user' | 'admin'): Promise<void> {
  await db.update(users).set({ role }).where(eq(users.id, id));
}

export async function deleteUser(db: Db, id: string): Promise<void> {
  await db.delete(users).where(eq(users.id, id));
}

export async function getAllProjects(db: Db, limit: number, offset: number): Promise<Project[]> {
  return db.select().from(projects).orderBy(desc(projects.created_at)).limit(limit).offset(offset);
}

export async function searchProjects(
  db: Db,
  query: string,
): Promise<
  (Project & {
    owner_login: string | null;
    last_deploy: string | null;
    last_deploy_id: string | null;
    last_deploy_status: string | null;
  })[]
> {
  const pattern = `%${query}%`;
  const lastDeploy = db
    .select({
      project_id: deployments.project_id,
      last_deploy: sql<string>`max(${deployments.created_at})`.as('last_deploy'),
      last_deploy_id:
        sql<string>`(SELECT id FROM deployments d2 WHERE d2.project_id = ${deployments.project_id} ORDER BY d2.created_at DESC LIMIT 1)`.as(
          'last_deploy_id',
        ),
      last_deploy_status:
        sql<string>`(SELECT status FROM deployments d3 WHERE d3.project_id = ${deployments.project_id} ORDER BY d3.created_at DESC LIMIT 1)`.as(
          'last_deploy_status',
        ),
    })
    .from(deployments)
    .groupBy(deployments.project_id)
    .as('last_deploy_sq');

  return db
    .select({
      ...getTableColumns(projects),
      owner_login: users.login,
      last_deploy: lastDeploy.last_deploy,
      last_deploy_id: lastDeploy.last_deploy_id,
      last_deploy_status: lastDeploy.last_deploy_status,
    })
    .from(projects)
    .leftJoin(users, eq(projects.user_id, users.id))
    .leftJoin(lastDeploy, eq(projects.id, lastDeploy.project_id))
    .where(
      or(ilike(projects.slug, pattern), ilike(users.login, pattern), ilike(projects.id, pattern)),
    )
    .orderBy(desc(projects.created_at))
    .limit(50);
}

export async function searchDeployments(
  db: Db,
  query: string,
): Promise<(Deployment & { project_slug: string | null; active_deployment_id: string | null })[]> {
  const pattern = `%${query}%`;
  return db
    .select({
      ...getTableColumns(deployments),
      project_slug: projects.slug,
      active_deployment_id: projects.active_deployment_id,
    })
    .from(deployments)
    .leftJoin(projects, eq(deployments.project_id, projects.id))
    .where(
      or(
        ilike(deployments.id, pattern),
        ilike(projects.slug, pattern),
        ilike(deployments.status, pattern),
        ilike(deployments.commit, pattern),
        ilike(deployments.source, pattern),
      ),
    )
    .orderBy(desc(deployments.created_at))
    .limit(50);
}

export async function getAllProjectsWithOwner(
  db: Db,
  limit: number,
  offset: number,
): Promise<
  (Project & {
    owner_login: string | null;
    last_deploy: string | null;
    last_deploy_id: string | null;
    last_deploy_status: string | null;
  })[]
> {
  const lastDeploy = db
    .select({
      project_id: deployments.project_id,
      last_deploy: sql<string>`max(${deployments.created_at})`.as('last_deploy'),
      last_deploy_id:
        sql<string>`(SELECT id FROM deployments d2 WHERE d2.project_id = ${deployments.project_id} ORDER BY d2.created_at DESC LIMIT 1)`.as(
          'last_deploy_id',
        ),
      last_deploy_status:
        sql<string>`(SELECT status FROM deployments d3 WHERE d3.project_id = ${deployments.project_id} ORDER BY d3.created_at DESC LIMIT 1)`.as(
          'last_deploy_status',
        ),
    })
    .from(deployments)
    .groupBy(deployments.project_id)
    .as('last_deploy_sq');

  return db
    .select({
      ...getTableColumns(projects),
      owner_login: users.login,
      last_deploy: lastDeploy.last_deploy,
      last_deploy_id: lastDeploy.last_deploy_id,
      last_deploy_status: lastDeploy.last_deploy_status,
    })
    .from(projects)
    .leftJoin(users, eq(projects.user_id, users.id))
    .leftJoin(lastDeploy, eq(projects.id, lastDeploy.project_id))
    .orderBy(desc(projects.created_at))
    .limit(limit)
    .offset(offset);
}

// --- Consolidated queries (previously inline) ---

export async function getFirstAdmin(db: Db) {
  const [row] = await db
    .select({ id: users.id, login: users.login })
    .from(users)
    .where(eq(users.role, 'admin'))
    .limit(1);
  return row ?? null;
}

export async function updateUserProviderId(db: Db, id: string, providerId: string): Promise<void> {
  await db.update(users).set({ provider_id: providerId }).where(eq(users.id, id));
}

export async function getAllUsersWithPlan(db: Db) {
  return db
    .select({
      id: users.id,
      plan: users.plan,
      billing_cycle_start: users.billing_cycle_start,
    })
    .from(users);
}

export async function getUsersWithProjectsBatch(db: Db, limit: number, offset: number) {
  const userRows = await db
    .select({
      id: users.id,
      plan: users.plan,
      billing_cycle_start: users.billing_cycle_start,
      suspended_reason: users.suspended_reason,
    })
    .from(users)
    .orderBy(asc(users.id))
    .limit(limit)
    .offset(offset);

  if (userRows.length === 0) {
    return [];
  }

  const userIds = userRows.map((u) => u.id);
  const projectRows = await db
    .select({ id: projects.id, slug: projects.slug, user_id: projects.user_id })
    .from(projects)
    .where(inArray(projects.user_id, userIds));

  const projectsByUser = new Map<string, typeof projectRows>();
  for (const p of projectRows) {
    const list = projectsByUser.get(p.user_id) ?? [];
    list.push(p);
    projectsByUser.set(p.user_id, list);
  }

  return userRows.map((user) => ({
    user,
    projects: projectsByUser.get(user.id) ?? [],
  }));
}

export async function unsuspendUserIfReason(db: Db, id: string, reason: string): Promise<void> {
  await db
    .update(users)
    .set({ suspended_reason: null })
    .where(and(eq(users.id, id), eq(users.suspended_reason, reason)));
}

// --- Platform Events ---

export async function createPlatformEvent(
  db: Db,
  event: Omit<PlatformEvent, 'created_at'>,
): Promise<PlatformEvent> {
  const [row] = await db.insert(platformEvents).values(event).returning();
  return row;
}

export async function updatePlatformEventStatus(
  db: Db,
  id: string,
  status: PlatformEvent['status'],
  errorMessage?: string,
): Promise<void> {
  await db
    .update(platformEvents)
    .set({ status, error_message: errorMessage ?? null })
    .where(eq(platformEvents.id, id));
}

export async function skipPendingBatchEvents(db: Db, batchId: string): Promise<void> {
  await db
    .update(platformEvents)
    .set({ status: 'skipped' })
    .where(and(eq(platformEvents.batch_id, batchId), eq(platformEvents.status, 'pending')));
}

export async function getPlatformEventsByBatchId(
  db: Db,
  batchId: string,
): Promise<PlatformEvent[]> {
  return db
    .select()
    .from(platformEvents)
    .where(eq(platformEvents.batch_id, batchId))
    .orderBy(asc(platformEvents.created_at));
}

export async function getRecentPlatformEvents(
  db: Db,
  environment: PlatformEvent['environment'],
  limit = 20,
): Promise<PlatformEvent[]> {
  return db
    .select()
    .from(platformEvents)
    .where(eq(platformEvents.environment, environment))
    .orderBy(desc(platformEvents.created_at))
    .limit(limit);
}

// --- Invitations ---

export async function createInvitation(
  db: Db,
  email: string,
  invitedBy: string,
): Promise<Invitation> {
  const id = generateId('inv');
  const [row] = await db
    .insert(invitations)
    .values({ id, email: email.toLowerCase(), invited_by: invitedBy })
    .returning();
  return row;
}

export async function revokeInvitation(db: Db, id: string, revokedBy: string): Promise<boolean> {
  const rows = await db
    .update(invitations)
    .set({ status: 'revoked', revoked_at: sql`now()`, revoked_by: revokedBy })
    .where(and(eq(invitations.id, id), eq(invitations.status, 'pending')))
    .returning({ id: invitations.id });
  return rows.length > 0;
}

export async function acceptInvitationByEmail(
  db: Db,
  email: string,
  userId: string,
): Promise<void> {
  await db
    .update(invitations)
    .set({ status: 'accepted', accepted_by: userId, accepted_at: sql`now()` })
    .where(and(eq(invitations.email, email.toLowerCase()), eq(invitations.status, 'pending')));
}

export async function getAllInvitations(
  db: Db,
  limit: number,
  offset: number,
): Promise<(Invitation & { invited_by_login: string | null; revoked_by_login: string | null })[]> {
  const invitedByUser = alias(users, 'invited_by_user');
  const revokedByUser = alias(users, 'revoked_by_user');
  return db
    .select({
      ...getTableColumns(invitations),
      invited_by_login: invitedByUser.login,
      revoked_by_login: revokedByUser.login,
    })
    .from(invitations)
    .leftJoin(invitedByUser, eq(invitations.invited_by, invitedByUser.id))
    .leftJoin(revokedByUser, eq(invitations.revoked_by, revokedByUser.id))
    .orderBy(desc(invitations.created_at))
    .limit(limit)
    .offset(offset);
}

export async function countInvitations(db: Db): Promise<number> {
  const [result] = await db.select({ count: count() }).from(invitations);
  return result?.count ?? 0;
}

export async function getInvitation(db: Db, id: string): Promise<Invitation | null> {
  const [row] = await db.select().from(invitations).where(eq(invitations.id, id)).limit(1);
  return row ?? null;
}

export async function getPendingInvitationByEmail(
  db: Db,
  email: string,
): Promise<Invitation | null> {
  const [row] = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.email, email.toLowerCase()), eq(invitations.status, 'pending')))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// oauth nonces
// ---------------------------------------------------------------------------

export async function storeOAuthNonce(db: Db, nonce: string, ttlSeconds: number): Promise<void> {
  await db
    .insert(oauthNonces)
    .values({ nonce, expires_at: sql`now() + ${String(ttlSeconds)} * interval '1 second'` });
}

/** Atomically consume a nonce — returns true if it existed and was not expired. */
export async function consumeOAuthNonce(db: Db, nonce: string): Promise<boolean> {
  const rows = await db
    .delete(oauthNonces)
    .where(and(eq(oauthNonces.nonce, nonce), sql`expires_at > now()`))
    .returning({ nonce: oauthNonces.nonce });
  return rows.length > 0;
}

/** Delete expired nonces left behind by abandoned login flows. */
export async function purgeExpiredOAuthNonces(db: Db): Promise<void> {
  await db.delete(oauthNonces).where(sql`expires_at <= now()`);
}

// ---------------------------------------------------------------------------
// auth codes (dashboard login code exchange)
// ---------------------------------------------------------------------------

export async function storeAuthCode(
  db: Db,
  code: string,
  jwt: string,
  ttlSeconds: number,
): Promise<void> {
  await db
    .insert(authCodes)
    .values({ code, jwt, expires_at: sql`now() + ${String(ttlSeconds)} * interval '1 second'` });
}

/** Atomically consume an auth code — returns the JWT if valid, null otherwise. */
export async function consumeAuthCode(db: Db, code: string): Promise<string | null> {
  const rows = await db
    .delete(authCodes)
    .where(and(eq(authCodes.code, code), sql`expires_at > now()`))
    .returning({ jwt: authCodes.jwt });
  return rows[0]?.jwt ?? null;
}

/** Delete expired auth codes left behind by abandoned login flows. */
export async function purgeExpiredAuthCodes(db: Db): Promise<void> {
  await db.delete(authCodes).where(sql`expires_at <= now()`);
}
