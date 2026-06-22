import {
  and,
  count,
  desc,
  asc,
  eq,
  ne,
  lt,
  gt,
  gte,
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
import { generateId } from './id.ts';
import * as schema from './schema.ts';
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
  projectMigrations,
  projectDatabaseCredentials,
} from './schema.ts';
import type { DomainVerificationData } from './schema.ts';
import type { AllowlistEntry } from './signup-allowlist.ts';
import type { PlanId } from './tiers.ts';
import type {
  Deployment,
  DeploymentStatus,
  Domain,
  Invitation,
  OAuthAccount,
  PlatformEvent,
  ProjectDatabaseCredentials,
  ProjectSecret,
  Project,
  Resource,
  User,
} from './types.ts';

export function createDb(connectionString: string) {
  return drizzle(connectionString, { schema });
}
export type Db = ReturnType<typeof createDb>;

export const TERMINAL_DEPLOYMENT_STATUSES: Array<DeploymentStatus> = ['live', 'failed', 'canceled'];
export const CANCELLATION_REQUESTED_DEPLOYMENT_STATUSES: Array<DeploymentStatus> = [
  'canceling',
  'canceled',
];

export type AllowlistEntryStatus = AllowlistEntry & {
  accepted: boolean;
  deployed: boolean;
};

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

export async function getUsersByIds(
  db: Db,
  ids: ReadonlyArray<string>,
): Promise<ReadonlyArray<User>> {
  if (ids.length === 0) {
    return [];
  }

  return db.select().from(users).where(inArray(users.id, ids));
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
  // Excludes precheck placeholder rows (manifest IS NULL). Those represent
  // in-flight deploys that have passed serialization but not yet validated
  // against quota; counting them would charge a deploy against quota BEFORE
  // the quota check fires for that same request, dropping the effective
  // daily limit by one for both streamed-static and worker-backed paths.
  // See deploy.ts placeholder insert (~line 1306) and quota check sites
  // (~lines 1725 / 2206).
  const [result] = await db
    .select({ count: count() })
    .from(deployments)
    .innerJoin(projects, eq(deployments.project_id, projects.id))
    .where(
      and(
        eq(projects.user_id, userId),
        sql`${deployments.created_at} >= CURRENT_DATE`,
        isNotNull(deployments.manifest),
      ),
    );
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

export async function getProjectsByUserId(db: Db, userId: string): Promise<ReadonlyArray<Project>> {
  return db
    .select()
    .from(projects)
    .where(eq(projects.user_id, userId))
    .orderBy(desc(projects.created_at));
}

export async function getLatestDeploymentsByProjectIds(
  db: Db,
  projectIds: ReadonlyArray<string>,
): Promise<
  Map<
    string,
    Pick<
      Deployment,
      'id' | 'project_id' | 'status' | 'source' | 'commit' | 'created_at' | 'deployed_at'
    >
  >
> {
  if (projectIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({
      id: deployments.id,
      project_id: deployments.project_id,
      status: deployments.status,
      source: deployments.source,
      commit: deployments.commit,
      created_at: deployments.created_at,
      deployed_at: deployments.deployed_at,
    })
    .from(deployments)
    .where(inArray(deployments.project_id, projectIds))
    .orderBy(desc(deployments.created_at));

  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!latest.has(row.project_id)) {
      latest.set(row.project_id, row);
    }
  }
  return latest;
}

export async function getProjectsByIds(
  db: Db,
  ids: ReadonlyArray<string>,
): Promise<ReadonlyArray<Project>> {
  if (ids.length === 0) {
    return [];
  }

  return db.select().from(projects).where(inArray(projects.id, ids));
}

export async function getProjectsWithOwnerByIds(
  db: Db,
  ids: ReadonlyArray<string>,
): Promise<
  ReadonlyArray<
    Project & {
      owner_login: string | null;
    }
  >
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
  metadata?: {
    cliVersion?: string | null;
    commitUrl?: string | null;
    gitRef?: string | null;
    repositoryUrl?: string | null;
  },
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
      repository_url: metadata?.repositoryUrl ?? null,
      commit_url: metadata?.commitUrl ?? null,
      git_ref: metadata?.gitRef ?? null,
      cli_version: metadata?.cliVersion ?? null,
    })
    .returning();
  return row;
}

/**
 * Fill in the manifest/source/git metadata on a deployment row that was inserted
 * pre-parse as an atomic concurrent-deploy claim (see the early FOR UPDATE
 * precheck in `routes/deploy.ts`). The row is created with NULL values for
 * these columns; this helper writes them once the multipart manifest has
 * been parsed and validated.
 */
export async function updateDeploymentManifest(
  db: Db,
  id: string,
  manifest: string,
  source: string | null,
  commit: string | null,
  metadata?: {
    cliVersion?: string | null;
    commitUrl?: string | null;
    gitRef?: string | null;
    repositoryUrl?: string | null;
  },
): Promise<Deployment> {
  const [row] = await db
    .update(deployments)
    .set({
      manifest,
      source,
      commit,
      repository_url: metadata?.repositoryUrl ?? null,
      commit_url: metadata?.commitUrl ?? null,
      git_ref: metadata?.gitRef ?? null,
      cli_version: metadata?.cliVersion ?? null,
      updated_at: sql`now()`,
    })
    .where(eq(deployments.id, id))
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

/**
 * Durable publish-complete marker. Set once ALL post-go-live routing KV keys
 * (slug, account, active domains, queues, asset-fallback metadata) have been
 * published. The hourly `reconcileLiveRouting` safety net selects only rows
 * where this is NOT true and republishes them byte-identically, so the mark is
 * idempotent and needs no CAS — a missed mark simply re-publishes next run.
 */
export async function markRoutingPublished(db: Db, deploymentId: string): Promise<void> {
  await db
    .update(deployments)
    .set({ routing_published: true })
    .where(eq(deployments.id, deploymentId));
}

/**
 * Clear the durable publish-complete marker. Set inside the rollback go-live tx
 * (alongside `setActiveDeployment`) so the target is committed-active but flagged
 * routing-UNPUBLISHED until the post-commit routing publish succeeds and re-marks
 * it. If the publish fails, the row stays `false` and the hourly
 * `reconcileLiveRouting` safety net republishes it byte-identically. Unlike the
 * legacy NULL marker, `false` rows are exempt from the reconciler's recency
 * window (see `getRecentlyLiveActiveDeployments`) — a rollback target is usually
 * older than the window and must stay eligible until healed.
 */
export async function markRoutingUnpublished(db: Db, deploymentId: string): Promise<void> {
  await db
    .update(deployments)
    .set({ routing_published: false })
    .where(eq(deployments.id, deploymentId));
}

/**
 * Number of rows an UPDATE/DELETE touched, normalized across drivers: pg
 * (Hyperdrive, production) reports `rowCount`; PGlite (integration tests)
 * reports `affectedRows`. A guarded CAS must read whichever the active driver
 * provides — without this, a successful CAS reads as `undefined`/0 under PGlite
 * and the caller wrongly treats it as a no-op.
 */
function updatedRowCount(result: { rowCount?: number | null; affectedRows?: number }): number {
  return result.rowCount ?? result.affectedRows ?? 0;
}

/**
 * Atomically flip a deployment to `live` ONLY if it has not been canceled.
 *
 * Performs the same live transition as `updateDeploymentStatus(..., 'live')`
 * without `force` — `status='live'` and `deployed_at = COALESCE(deployed_at,
 * now())` — guarded by `status NOT IN ('canceling','canceled')`. Returns true
 * iff the row matched (i.e. the deploy went live), false if a cancel had
 * already committed.
 *
 * This is the atomic point-of-no-return in the deploy go-live tx. It replaces a
 * racy read-then-`force:true`: `cancelDeployment` does a lock-free UPDATE that
 * does NOT lock the project row, so a plain read could pass and then a cancel
 * could commit before the forced write (cancel acked, deploy forced live
 * anyway). With this CAS the two writes serialize on the deployment row:
 *   - a cancel committed BEFORE → this matches 0 rows → caller throws → the
 *     generic catch re-reads canceling/canceled and marks the deploy canceled,
 *     NO routing written.
 *   - a cancel committing AFTER → it blocks on the row lock until this tx
 *     commits, then sees status='live' (terminal) → its own guarded UPDATE
 *     matches 0 rows → 409 (correct: deploy won the race, user rolls back).
 *
 * Reads `updatedRowCount` so the match is detected under PGlite (affectedRows)
 * as well as pg (rowCount).
 */
export async function markDeploymentLiveIfNotCanceled(
  db: Db,
  deploymentId: string,
): Promise<boolean> {
  const result = await db
    .update(deployments)
    .set({
      status: 'live',
      updated_at: sql`now()`,
      deployed_at: sql`COALESCE(${deployments.deployed_at}, now())`,
    })
    .where(
      and(
        eq(deployments.id, deploymentId),
        notInArray(deployments.status, CANCELLATION_REQUESTED_DEPLOYMENT_STATUSES),
      ),
    );
  return updatedRowCount(result) > 0;
}

export async function getDeployment(db: Db, id: string): Promise<Deployment | null> {
  const [row] = await db.select().from(deployments).where(eq(deployments.id, id)).limit(1);
  return row ?? null;
}

export async function getProjectDeployments(
  db: Db,
  projectId: string,
  limit = 5,
): Promise<ReadonlyArray<Deployment>> {
  return db
    .select()
    .from(deployments)
    .where(eq(deployments.project_id, projectId))
    .orderBy(desc(deployments.created_at))
    .limit(limit);
}

export async function getAllProjectDeployments(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<Deployment>> {
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
): Promise<
  ReadonlyArray<Deployment & { project_slug: string | null; active_deployment_id: string | null }>
> {
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

/**
 * Mark a deployment's worker bundle as durably persisted to R2 under
 * `worker-bundles/{project_id}/{deployment_id}/`. Set immediately AFTER
 * `persistWorkerBundle` resolves and BEFORE any cancellation check, so
 * the invariant `bundle_stored=true ⇒ rollbackable` holds: a future
 * rollback can validate the flag before invoking `replayWorkerBundle`.
 *
 * Static / SPA deploys never call this — they have no worker module to
 * bundle (their assets are content-addressed in R2 already), so their
 * `bundle_stored` correctly remains false.
 */
export async function markDeploymentBundleStored(db: Db, deploymentId: string): Promise<void> {
  await db.update(deployments).set({ bundle_stored: true }).where(eq(deployments.id, deploymentId));
}

export async function setAppliedMigrations(
  db: Db,
  deploymentId: string,
  migrations: ReadonlyArray<string>,
): Promise<void> {
  await db
    .update(deployments)
    .set({ applied_migrations: JSON.stringify(migrations) })
    .where(eq(deployments.id, deploymentId));
}

export async function getProjectMigrationNames(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<string>> {
  const rows = await db
    .select({ name: projectMigrations.name })
    .from(projectMigrations)
    .where(eq(projectMigrations.project_id, projectId))
    .orderBy(asc(projectMigrations.applied_at), asc(projectMigrations.name));
  return rows.map((row) => row.name);
}

export async function getProjectMigrationRows(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<{ name: string; applied_at: string }>> {
  return db
    .select({ name: projectMigrations.name, applied_at: projectMigrations.applied_at })
    .from(projectMigrations)
    .where(eq(projectMigrations.project_id, projectId))
    .orderBy(asc(projectMigrations.applied_at), asc(projectMigrations.name));
}

export async function appendProjectMigrations(
  db: Db,
  projectId: string,
  names: ReadonlyArray<string>,
  sourceDeploymentId?: string,
): Promise<void> {
  const uniqueNames = [...new Set(names)];
  if (uniqueNames.length === 0) {
    return;
  }
  await db
    .insert(projectMigrations)
    .values(
      uniqueNames.map((name) => ({
        name,
        project_id: projectId,
        source_deployment_id: sourceDeploymentId,
      })),
    )
    .onConflictDoNothing();
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
  newMigrations: ReadonlyArray<string>,
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
    const existing: Array<string> = rows[0]!.applied_migrations
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
  `)) as { rows: ReadonlyArray<unknown> };
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
  renames: ReadonlyArray<{ from: string; to: string }>,
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
      const parsed: Array<string> = JSON.parse(row.applied_migrations);
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

export async function renameProjectMigrations(
  db: Db,
  projectId: string,
  renames: ReadonlyArray<{ from: string; to: string }>,
): Promise<void> {
  for (const rename of renames) {
    await db
      .update(projectMigrations)
      .set({ name: rename.to })
      .where(
        and(eq(projectMigrations.project_id, projectId), eq(projectMigrations.name, rename.from)),
      );
  }
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
  pairs: ReadonlyArray<{ from: string; to: string }>,
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

export async function getRetainedDeployments(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<Deployment>> {
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
): Promise<ReadonlyArray<Deployment>> {
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

/**
 * Every deployment that has ever reached `live` (deployed_at IS NOT NULL),
 * regardless of current retention. Used by the rollback queue sweep to
 * union every queue that was ever owned by an activated deployment.
 */
export async function getActivatedDeployments(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<Deployment>> {
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
): Promise<ReadonlyArray<Deployment>> {
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
): Promise<ReadonlyArray<{ name: string }>> {
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

export async function getProjectSecrets(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<ProjectSecret>> {
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

// --- Database credentials ---

export async function upsertProjectDatabaseUrl(
  db: Db,
  projectId: string,
  ciphertext: string,
  iv: string,
  keyVersion: string,
): Promise<ProjectDatabaseCredentials> {
  const [row] = await db
    .insert(projectDatabaseCredentials)
    .values({ project_id: projectId, ciphertext, iv, key_version: keyVersion })
    .onConflictDoUpdate({
      target: projectDatabaseCredentials.project_id,
      set: {
        ciphertext,
        iv,
        key_version: keyVersion,
        updated_at: sql`now()`,
      },
    })
    .returning();
  return row;
}

export async function getProjectDatabaseUrl(
  db: Db,
  projectId: string,
): Promise<ProjectDatabaseCredentials | null> {
  const [row] = await db
    .select()
    .from(projectDatabaseCredentials)
    .where(eq(projectDatabaseCredentials.project_id, projectId))
    .limit(1);
  return row ?? null;
}

export async function deleteProjectDatabaseUrl(db: Db, projectId: string): Promise<void> {
  await db
    .delete(projectDatabaseCredentials)
    .where(eq(projectDatabaseCredentials.project_id, projectId));
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

export async function getProjectResources(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<Resource>> {
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

/**
 * Upsert a `container` resource row, returning the prior `cf_id` when an
 * existing row's id was updated to a new application id.
 *
 * Container applications can be replaced out-of-band: the CF API can return
 * 404 when an operator deletes a stale same-name app (or the namespace-mismatch
 * remediation the deploy path now relies on tells the operator to delete it).
 * In those cases `upsertSandboxContainerApplication` POSTs a fresh app and
 * returns a new `application.id`. The old `createResource`-only path skipped
 * persistence whenever a row already existed for the binding, leaving the DB
 * pointing at a dead `cf_id` — cleanup later 404s on that id and the new app
 * leaks. This helper closes that hole by reconciling on the natural unique
 * key `(project_id, type, binding_name)`.
 *
 * Returns `{ priorCfId }` so callers can log the transition. `priorCfId` is
 * `null` when a new row was inserted, the same string as `cfId` when the row
 * already pointed at the same id (no-op), and the prior id when an existing
 * row was updated to point at a new application.
 */
export async function upsertContainerResource(
  db: Db,
  projectId: string,
  bindingName: string,
  cfId: string,
): Promise<{ priorCfId: string | null }> {
  // Read first so we can report the prior cf_id even on the update path.
  // Drizzle's RETURNING returns post-update columns; without this read we
  // could not distinguish "inserted" from "updated to same id" from
  // "updated to a new id" cleanly.
  const prior = await db
    .select({ cf_id: resources.cf_id })
    .from(resources)
    .where(
      and(
        eq(resources.project_id, projectId),
        eq(resources.type, 'container'),
        eq(resources.binding_name, bindingName),
      ),
    )
    .then((rows) => rows[0]);

  await db
    .insert(resources)
    .values({
      id: generateId('res'),
      project_id: projectId,
      type: 'container',
      cf_id: cfId,
      binding_name: bindingName,
    })
    .onConflictDoUpdate({
      target: [resources.project_id, resources.type, resources.binding_name],
      set: { cf_id: cfId },
    });

  return { priorCfId: prior?.cf_id ?? null };
}

// --- Domains ---

export async function createDomain(
  db: Db,
  projectId: string,
  hostname: string,
  cfHostnameId: string,
  verificationData?: DomainVerificationData | null,
): Promise<Domain> {
  const id = generateId('dom');
  const [row] = await db
    .insert(domains)
    .values({
      id,
      project_id: projectId,
      hostname,
      cf_hostname_id: cfHostnameId,
      verification_data: verificationData ?? null,
    })
    .returning();
  return row;
}

export async function getDomainsByProjectId(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<Domain>> {
  return db
    .select()
    .from(domains)
    .where(eq(domains.project_id, projectId))
    .orderBy(asc(domains.created_at));
}

export async function getDomainsByProjectIds(
  db: Db,
  projectIds: ReadonlyArray<string>,
): Promise<Map<string, ReadonlyArray<Domain>>> {
  const allDomains = await db
    .select()
    .from(domains)
    .where(inArray(domains.project_id, projectIds))
    .orderBy(asc(domains.created_at));

  const map = new Map<string, Array<Domain>>();
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

export async function getDomainByHostnameOrCfHostnameId(
  db: Db,
  hostname: string,
  cfHostnameId: string,
): Promise<Domain | null> {
  const [row] = await db
    .select()
    .from(domains)
    .where(or(eq(domains.hostname, hostname), eq(domains.cf_hostname_id, cfHostnameId)))
    .limit(1);
  return row ?? null;
}

export async function getDomain(db: Db, id: string): Promise<Domain | null> {
  const [row] = await db.select().from(domains).where(eq(domains.id, id)).limit(1);
  return row ?? null;
}

// Stale custom hostnames that never verified — for the cleanup janitor. Only
// `pending` rows are eligible; `created_at` is a string-mode timestamp so the
// cutoff is compared as an ISO string. Capped at `limit` and ordered
// oldest-first (most overdue cleaned first) so a large stale backlog cannot
// starve later hourly maintenance.
export async function getPendingDomainsOlderThan(
  db: Db,
  isoCutoff: string,
  limit: number,
): Promise<ReadonlyArray<Domain>> {
  return db
    .select()
    .from(domains)
    .where(and(eq(domains.status, 'pending'), lt(domains.created_at, isoCutoff)))
    .orderBy(asc(domains.created_at))
    .limit(limit);
}

// All pending custom-hostname rows (cron hourly reconciliation tier). Capped
// at `limit` and ordered oldest-first so domains nearest the 7-day cleanup are
// reconciled before the per-run cap truncates the batch.
export async function getPendingDomains(db: Db, limit: number): Promise<ReadonlyArray<Domain>> {
  return db
    .select()
    .from(domains)
    .where(eq(domains.status, 'pending'))
    .orderBy(asc(domains.created_at))
    .limit(limit);
}

// Recently-created pending rows (cron 30-min fast reconciliation tier).
// `created_at` is a string-mode timestamp, compared as an ISO string. Capped at
// `limit` and ordered oldest-first so the per-run cap truncates the newest
// (least urgent) domains rather than starving older ones.
export async function getPendingDomainsNewerThan(
  db: Db,
  isoCutoff: string,
  limit: number,
): Promise<ReadonlyArray<Domain>> {
  return db
    .select()
    .from(domains)
    .where(and(eq(domains.status, 'pending'), gte(domains.created_at, isoCutoff)))
    .orderBy(asc(domains.created_at))
    .limit(limit);
}

/**
 * Active live deployments whose routing publish is incomplete — the input to
 * the hourly live-routing reconciler (`reconcileLiveRouting` in `index.ts`).
 *
 * Joins each project to its CURRENT active deployment (the `active_deployment_id`
 * pointer the deploy/rollback go-live tx flips) and keeps only `live` rows not
 * yet marked `routing_published`: a deploy/rollback that committed live but
 * failed to publish routing KV (e.g. a transient KV error after the go-live tx,
 * with all in-request retries exhausted) leaves a missing/stale slug route, and
 * on a FIRST deploy the project is then unreachable (dispatch routes purely from
 * ROUTING KV). The reconciler republishes slug/account/domain routing from the
 * manifest below.
 *
 * The two unpublished marker states have different eligibility:
 * - NULL — pre-marker legacy rows. Window-bounded backfill: eligible only when
 *   `deployed_at > sinceIso`, or the fleet-wide NULL backlog would dominate
 *   every scan.
 * - false — explicitly unpublished; the only writer is `markRoutingUnpublished`
 *   inside the rollback go-live tx. ALWAYS eligible, no window: a rollback
 *   target is usually older than any recency window, and the set is bounded —
 *   the join keeps only active-pointer rows, and a healed row flips to true and
 *   self-clears.
 *
 * `deployed_at` is a string-mode timestamp, so the cutoff is compared as an ISO
 * string. Capped at `limit` (mirrors `getPendingDomains`) and ordered
 * oldest-first so the per-run cap truncates the least-stale rows.
 */
export async function getRecentlyLiveActiveDeployments(
  db: Db,
  sinceIso: string,
  limit: number,
): Promise<
  ReadonlyArray<{
    projectId: string;
    slug: string;
    userId: string;
    type: Project['type'];
    deploymentId: string;
    manifest: string | null;
    assetHashes: string | null;
  }>
> {
  return db
    .select({
      projectId: projects.id,
      slug: projects.slug,
      userId: projects.user_id,
      type: projects.type,
      deploymentId: deployments.id,
      manifest: deployments.manifest,
      assetHashes: deployments.asset_hashes,
    })
    .from(projects)
    .innerJoin(deployments, eq(deployments.id, projects.active_deployment_id))
    .where(
      and(
        eq(deployments.status, 'live'),
        // Defense-in-depth: never reconcile a project being torn down.
        // `teardownProject` flips `status='deleting'`, deletes the routing KV
        // entries lock-free, then cascade-deletes the row last — re-publishing
        // here would recreate orphan routes the reconciler can never heal once
        // the row is gone. `publishRoutingIfStillActive` also re-checks this
        // under the project lock; excluding deleting rows from the snapshot
        // avoids the wasted lock + re-check entirely.
        ne(projects.status, 'deleting'),
        // Skip rows whose routing is already fully published — `ne(col, true)`
        // would exclude NULLs in SQL three-valued logic, so spell out each
        // unpublished state. The recency window applies ONLY to legacy NULL
        // rows; explicitly-unpublished (false) rows must stay eligible at any
        // age or a failed rollback publish to a >window-old target never heals.
        or(
          and(isNull(deployments.routing_published), gt(deployments.deployed_at, sinceIso)),
          eq(deployments.routing_published, false),
        ),
      ),
    )
    .orderBy(asc(deployments.deployed_at))
    .limit(limit);
}

/**
 * Lock a project row `FOR UPDATE` and return its CURRENT
 * `active_deployment_id`. The lock serializes against the deploy/rollback
 * go-live tx (which also takes `SELECT id FROM projects WHERE id = ? FOR
 * UPDATE` before flipping the pointer — see `deploy.ts`), so a caller holding
 * this lock observes a stable active pointer for the lifetime of its tx.
 *
 * Used by the hourly live-routing reconciler: it SELECTs a snapshot of active
 * deployments, then per-row re-reads the pointer under this lock to confirm the
 * snapshot's deployment is STILL active before publishing its routing — so a
 * concurrent deploy that flipped the pointer to a newer deployment cannot have
 * its routing clobbered by the reconciler's stale snapshot.
 *
 * MUST be called inside a transaction (`db` is the tx-scoped `Db`); a `FOR
 * UPDATE` outside a tx releases the lock immediately and is pointless.
 */
export async function lockProjectAndGetActiveDeploymentId(
  db: Db,
  projectId: string,
): Promise<string | null> {
  const result = (await db.execute(
    sql`SELECT active_deployment_id FROM projects WHERE id = ${projectId} FOR UPDATE`,
  )) as { rows: ReadonlyArray<{ active_deployment_id: string | null }> };
  return result.rows[0]?.active_deployment_id ?? null;
}

/**
 * Lock-and-read variant for the publish chokepoint: takes the SAME project-row
 * `FOR UPDATE` lock as {@link lockProjectAndGetActiveDeploymentId}, but returns
 * BOTH `active_deployment_id` AND `status`, or `null` when the row is gone.
 *
 * `publishRoutingIfStillActive` needs the status too: project teardown
 * (`teardownProject`) flips `projects.status='deleting'` WITHOUT moving
 * `active_deployment_id` away from the still-`live` deployment (`live` is
 * terminal, so the deployment is not marked `canceling`), then deletes the
 * routing KV entries lock-free and cascade-deletes the row LAST. In that gap a
 * parked publisher (or the reconciler) would re-pass a pointer-only active check
 * and RE-CREATE the routing it just tore down — and once the row is gone the
 * reconciler can never heal it (its join returns nothing) → permanent orphan
 * routes. Reading `status` under the lock lets the publisher treat a deleting /
 * missing project as superseded and write nothing.
 *
 * A SEPARATE sibling (not an extension of
 * `lockProjectAndGetActiveDeploymentId`) keeps the change scoped: that helper
 * has callers (deploy / reconciler backfill / domain activate / queue-token
 * backfill / guardedRoutingKvRmw) that only acquire the lock or compare the
 * pointer to a specific id, and folding a status check into it would alter those
 * unrelated paths.
 *
 * MUST be called inside a transaction (same `FOR UPDATE` constraint).
 */
export async function lockProjectForPublish(
  db: Db,
  projectId: string,
): Promise<{ activeDeploymentId: string | null; status: Project['status'] } | null> {
  const result = (await db.execute(
    sql`SELECT active_deployment_id, status FROM projects WHERE id = ${projectId} FOR UPDATE`,
  )) as {
    rows: ReadonlyArray<{ active_deployment_id: string | null; status: Project['status'] }>;
  };
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return { activeDeploymentId: row.active_deployment_id ?? null, status: row.status };
}

/**
 * Lock-guarded read-modify-write of a SINGLE project-scoped routing KV entry.
 *
 * Under the routing-after-tx model a project's slug / `queue:*` / `domain:*`
 * routing entry is written by a guarded publisher (deploy / rollback /
 * reconciler) ONLY after that publisher takes the project `FOR UPDATE` lock and
 * re-reads `active_deployment_id` under it. Any OTHER mutation of the same entry
 * (admin suspend/unsuspend, usage-counter suspension, queue-token backfill) must
 * take the SAME lock and RE-READ the entry under it before writing — otherwise a
 * lock-free read-then-write clobbers a concurrent publisher's NEWER route, and
 * because the newer active deployment is already `routing_published=true` the
 * hourly `reconcileLiveRouting` safety net (which heals only unpublished rows)
 * never repairs it: the clobber is permanent.
 *
 * This helper wraps that pattern. It opens a transaction, takes the project
 * `FOR UPDATE` lock, RE-READS the entry under the lock, and runs `mutate` on the
 * FRESH under-lock value. `mutate` returns the next entry to `put`, or `null` to
 * skip the write entirely (e.g. the entry already has / no longer needs the
 * mutation). A concurrent publish either committed BEFORE this lock (the re-read
 * observes its fresh value, and `mutate` decides against the stale clobber) or
 * serializes BEHIND this short RMW. No-op when the key is absent.
 *
 * The KV put nests no further pg write — same shape as the reconciler's lock +
 * KV publish. PGlite (tests) is single-connection, so ALL reads/writes for the
 * project happen inside this one lock-tx; callers must not interleave an outer
 * `db` read while the lock-tx is open.
 */
export async function guardedRoutingKvRmw(
  db: Db,
  projectId: string,
  kv: KVNamespace,
  key: string,
  mutate: (entry: Record<string, unknown>) => Record<string, unknown> | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockProjectAndGetActiveDeploymentId(tx as unknown as Db, projectId);
    const raw = await kv.get(key);
    if (raw === null) {
      return;
    }
    const next = mutate(JSON.parse(raw) as Record<string, unknown>);
    if (next !== null) {
      await kv.put(key, JSON.stringify(next));
    }
  });
}

/**
 * Outcome of {@link publishRoutingIfStillActive}.
 *
 *   - `published`  — `deploymentId` was still the active deployment; `publish()`
 *                    ran (under the lock) and the row was marked published.
 *   - `superseded` — a NEWER operation already flipped `active_deployment_id`
 *                    away from `deploymentId`, OR the project is being deleted
 *                    (`status='deleting'`) / already gone; NO KV write, NO mark.
 *                    The newer active deployment owns routing and has/will
 *                    publish it, or teardown owns the (impending) absence of
 *                    routing and this publisher must not recreate it.
 *   - `failed`     — `deploymentId` was active but `publish()` threw; the mark
 *                    is NOT set, so the row stays routing-unpublished and the
 *                    hourly `reconcileLiveRouting` safety net heals it.
 */
export type PublishRoutingOutcome = 'published' | 'superseded' | 'failed';

/**
 * Publish routing for `deploymentId` ONLY while it is still the project's active
 * deployment, serializing concurrent same-project publishers on the project row
 * lock so a stale (parked/slow) publisher can never clobber a newer operation's
 * routing.
 *
 * The deploy/rollback go-live tx flips `active_deployment_id` then publishes
 * routing KV POST-commit (DB-ahead-of-KV — see `deploy.ts`/`projects.ts`). A
 * publisher that gets parked after its go-live commit can land AFTER a newer
 * operation has committed, published, and marked its own deployment
 * `routing_published=true`. Replaying the stale deployment's routing then both
 * clobbers the newer live routes (dispatch routes purely from these KV values)
 * AND stamps the stale row published — and because the newer active row is
 * already `routing_published=true`, the reconciler's `active AND NOT published`
 * query filters it out, so the stale routing persists permanently.
 *
 * This helper closes that race by mirroring the reconciler's lock + re-check: a
 * SEPARATE post-commit tx takes the SAME `SELECT ... FOR UPDATE` lock the
 * go-live tx and reconciler take, RE-READS `active_deployment_id` AND `status`,
 * and:
 *
 *   - if the project row is GONE, or its `status='deleting'`, or
 *     `active_deployment_id` no longer equals `deploymentId` → returns
 *     `'superseded'` (no KV write, no mark): a newer operation owns routing, or
 *     teardown is removing this project and the publisher must not recreate the
 *     routing it just tore down. Project teardown (`teardownProject`) flips
 *     `status='deleting'` but leaves the pointer on the still-`live` deployment,
 *     deletes routing KV lock-free, then cascade-deletes the row last — so a
 *     pointer-only check would re-pass and re-create orphan routes the
 *     reconciler can never heal (the row is gone). Reading `status` under the
 *     lock (the same `status==='deleting'` re-check the go-live tx already does)
 *     closes both the parked-publisher and reconciler vectors here.
 *   - else runs `publish(txDb)` (the KV puts) UNDER THE LOCK, then
 *     `markRoutingPublished`, and returns `'published'`. Holding the lock across
 *     `publish()` + the mark makes "marked published" truthful and serializes
 *     concurrent same-project publishers, so a stale one blocks (then
 *     short-circuits as superseded) rather than clobbering. The lock-tx db
 *     handle is passed to `publish` so it can re-read project state (e.g. the
 *     active domain set) under the lock instead of from a pre-publish snapshot
 *     that a concurrent domain activate/delete could have invalidated.
 *   - if `publish()` throws → returns `'failed'` (mark NOT set): the row stays
 *     unmarked and any KV already written is healed byte-identically by the
 *     reconciler.
 *
 * The publish stays POST-commit: this helper re-acquires the lock in its OWN tx
 * AFTER the go-live commit. It does NOT move routing writes back into the
 * go-live tx (which would reopen the original "failed publish rolls back the
 * go-live" clobber class). `publish()` performs the external KV puts while the
 * pg lock is held — the same shape the reconciler already runs successfully on
 * PGlite (single-connection) and pg.
 */
export async function publishRoutingIfStillActive(
  db: Db,
  projectId: string,
  deploymentId: string,
  publish: (txDb: Db) => Promise<void>,
): Promise<PublishRoutingOutcome> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const locked = await lockProjectForPublish(txDb, projectId);
    // Row gone (cascade-deleted by teardown), project being deleted, or the
    // pointer moved to a newer deployment → a newer operation owns routing, or
    // teardown owns the (impending) absence of it. Write nothing.
    if (
      locked === null ||
      locked.status === 'deleting' ||
      locked.activeDeploymentId !== deploymentId
    ) {
      return 'superseded';
    }
    try {
      // Pass the lock-tx db handle so the closure can re-read project state
      // (e.g. active domains) UNDER THE LOCK rather than from a pre-publish
      // snapshot. PGlite is single-connection, so the closure MUST use this
      // handle for any pg read — a read via the OUTER `db` while this tx holds
      // the lock would self-deadlock.
      await publish(txDb);
    } catch {
      // The KV puts threw. Do NOT mark published — the row stays
      // routing-unpublished and the reconciler heals it byte-identically. The
      // surrounding tx still commits (it only took a shared-pointer read lock
      // and wrote nothing), releasing the lock for the next publisher.
      return 'failed';
    }
    // The KV puts SUCCEEDED — routing is now live. The mark is a best-effort,
    // idempotent, CAS-free flag (see `markRoutingPublished`): a transient DB
    // failure here must NOT reject the helper, because rejecting would make the
    // caller treat an already-live publish as a hard error (rollback 500s after
    // the target is committed live; deploy diverts to its outer recovery path
    // and skips its normal 'published' epilogue). Swallow the mark failure and
    // still report 'published' — the row is simply left unmarked, and the
    // hourly `reconcileLiveRouting` safety net re-publishes byte-identically and
    // re-marks it on its next run.
    try {
      await markRoutingPublished(txDb, deploymentId);
    } catch (err) {
      console.error('routing_publish_mark_failed', {
        projectId,
        deploymentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return 'published';
  });
}

export async function updateDomainStatus(
  db: Db,
  id: string,
  status: Domain['status'],
): Promise<void> {
  await db.update(domains).set({ status }).where(eq(domains.id, id));
}

// Atomically flip a domain row to `active` ONLY if it is still `pending` (and
// belongs to `projectId`). This is the activation-side counterpart to
// `deleteDomainIfPending`: both statements are conditional on `status='pending'`,
// so under READ COMMITTED they mutually exclude at the ROW level — whichever
// commits first wins and the other matches 0 rows. A janitor delete can never
// be silently overwritten, and an activation can never silently match 0 rows
// after its KV write (the caller writes KV only AFTER this returns true).
// Returns true iff a pending row was claimed (flipped to active).
export async function activateDomainIfPending(
  db: Db,
  id: string,
  projectId: string,
): Promise<boolean> {
  const claimed = await db
    .update(domains)
    .set({ status: 'active' })
    .where(
      and(eq(domains.id, id), eq(domains.project_id, projectId), eq(domains.status, 'pending')),
    )
    .returning({ id: domains.id });
  return claimed.length > 0;
}

export async function updateDomainVerificationData(
  db: Db,
  id: string,
  data: DomainVerificationData | null,
): Promise<void> {
  await db.update(domains).set({ verification_data: data }).where(eq(domains.id, id));
}

export async function deleteDomain(db: Db, id: string): Promise<void> {
  await db.delete(domains).where(eq(domains.id, id));
}

// Atomically delete a domain row ONLY if it is still `pending`. Used by the
// cleanup janitor to "claim" a stale row: if a concurrent status poll has
// since activated the domain (status → 'active'), the delete is a no-op and
// returns false, so the janitor leaves the now-live domain (and its CF
// hostname) untouched. Returns true iff a pending row was deleted.
export async function deleteDomainIfPending(db: Db, id: string): Promise<boolean> {
  const deleted = await db
    .delete(domains)
    .where(and(eq(domains.id, id), eq(domains.status, 'pending')))
    .returning({ id: domains.id });
  return deleted.length > 0;
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

export async function getAllUsers(
  db: Db,
  limit: number,
  offset: number,
): Promise<ReadonlyArray<User>> {
  return db.select().from(users).orderBy(desc(users.created_at)).limit(limit).offset(offset);
}

export async function searchUsers(db: Db, query: string): Promise<ReadonlyArray<User>> {
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

export type CliVersionDeploymentStats = Readonly<{
  cli_version: string | null;
  deployments: number;
  projects: number;
  users: number;
  first_seen: string;
  last_seen: string;
}>;

export async function getCliVersionDeploymentStats(
  db: Db,
  options?: { sinceDays?: number },
): Promise<ReadonlyArray<CliVersionDeploymentStats>> {
  const sinceDays = options?.sinceDays;
  return db
    .select({
      cli_version: deployments.cli_version,
      deployments: sql<number>`count(*)::int`,
      projects: sql<number>`count(distinct ${deployments.project_id})::int`,
      users: sql<number>`count(distinct ${projects.user_id})::int`,
      first_seen: sql<string>`min(${deployments.created_at})`,
      last_seen: sql<string>`max(${deployments.created_at})`,
    })
    .from(deployments)
    .leftJoin(projects, eq(deployments.project_id, projects.id))
    .where(
      sinceDays && sinceDays > 0
        ? sql`${deployments.created_at} >= now() - (${sinceDays} * interval '1 day')`
        : sql`true`,
    )
    .groupBy(deployments.cli_version)
    .orderBy(desc(sql`count(*)`));
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

export async function getAllProjects(
  db: Db,
  limit: number,
  offset: number,
): Promise<ReadonlyArray<Project>> {
  return db.select().from(projects).orderBy(desc(projects.created_at)).limit(limit).offset(offset);
}

function getLatestDeploymentByProjectSubquery(db: Db) {
  return db
    .selectDistinctOn([deployments.project_id], {
      project_id: deployments.project_id,
      last_deploy: deployments.created_at,
      last_deploy_id: deployments.id,
      last_deploy_status: deployments.status,
    })
    .from(deployments)
    .orderBy(deployments.project_id, desc(deployments.created_at), desc(deployments.id))
    .as('last_deploy_sq');
}

export async function searchProjects(
  db: Db,
  query: string,
): Promise<
  ReadonlyArray<
    Project & {
      owner_login: string | null;
      last_deploy: string | null;
      last_deploy_id: string | null;
      last_deploy_status: string | null;
    }
  >
> {
  const pattern = `%${query}%`;
  const lastDeploy = getLatestDeploymentByProjectSubquery(db);

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
): Promise<
  ReadonlyArray<Deployment & { project_slug: string | null; active_deployment_id: string | null }>
> {
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
        ilike(deployments.cli_version, pattern),
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
  ReadonlyArray<
    Project & {
      owner_login: string | null;
      last_deploy: string | null;
      last_deploy_id: string | null;
      last_deploy_status: string | null;
    }
  >
> {
  const lastDeploy = getLatestDeploymentByProjectSubquery(db);

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

export async function getAllowlistEntryStatuses(
  db: Db,
  entries: ReadonlyArray<AllowlistEntry>,
): Promise<ReadonlyArray<AllowlistEntryStatus>> {
  if (entries.length === 0) {
    return [];
  }

  const exactEmails = Array.from(
    new Set(
      entries
        .filter((entry) => entry.type === 'email' && !entry.pattern.startsWith('*@'))
        .map((entry) => entry.pattern.toLowerCase()),
    ),
  );
  const emailDomains = Array.from(
    new Set(
      entries
        .filter((entry) => entry.type === 'email' && entry.pattern.startsWith('*@'))
        .map((entry) => entry.pattern.slice(1).toLowerCase()),
    ),
  );
  const githubLogins = Array.from(
    new Set(
      entries
        .filter((entry) => entry.type === 'github')
        .map((entry) => entry.pattern.toLowerCase()),
    ),
  );

  const userConditions = [
    exactEmails.length > 0 ? inArray(sql<string>`lower(${users.email})`, exactEmails) : undefined,
    githubLogins.length > 0
      ? and(eq(users.provider, 'github'), inArray(sql<string>`lower(${users.login})`, githubLogins))
      : undefined,
    ...emailDomains.map((domain) => sql`lower(${users.email}) like ${`%${domain}`}`),
  ].filter((condition) => condition !== undefined);

  const matchingUsers =
    userConditions.length > 0
      ? await db
          .select({
            id: users.id,
            provider: users.provider,
            login: users.login,
            email: users.email,
          })
          .from(users)
          .where(or(...userConditions))
      : [];

  const invitationConditions = [
    exactEmails.length > 0
      ? inArray(sql<string>`lower(${invitations.email})`, exactEmails)
      : undefined,
    ...emailDomains.map((domain) => sql`lower(${invitations.email}) like ${`%${domain}`}`),
  ].filter((condition) => condition !== undefined);

  const acceptedInvitations =
    invitationConditions.length > 0
      ? await db
          .select({ email: invitations.email })
          .from(invitations)
          .where(and(eq(invitations.status, 'accepted'), or(...invitationConditions)))
      : [];

  const matchingUserIds = matchingUsers.map((user) => user.id);
  const deployedUserRows =
    matchingUserIds.length > 0
      ? await db
          .select({ id: users.id })
          .from(users)
          .innerJoin(projects, eq(projects.user_id, users.id))
          .innerJoin(deployments, eq(deployments.project_id, projects.id))
          .where(and(inArray(users.id, matchingUserIds), isNotNull(deployments.deployed_at)))
      : [];
  const deployedUserIds = new Set(deployedUserRows.map((row) => row.id));

  function userMatchesEntry(user: (typeof matchingUsers)[number], entry: AllowlistEntry): boolean {
    if (entry.type === 'github') {
      return user.provider === 'github' && user.login.toLowerCase() === entry.pattern.toLowerCase();
    }

    if (!user.email) {
      return false;
    }

    const email = user.email.toLowerCase();
    const pattern = entry.pattern.toLowerCase();
    return pattern.startsWith('*@') ? email.endsWith(pattern.slice(1)) : email === pattern;
  }

  function invitationMatchesEntry(email: string, entry: AllowlistEntry): boolean {
    if (entry.type !== 'email') {
      return false;
    }

    const normalizedEmail = email.toLowerCase();
    const pattern = entry.pattern.toLowerCase();
    return pattern.startsWith('*@')
      ? normalizedEmail.endsWith(pattern.slice(1))
      : normalizedEmail === pattern;
  }

  return entries.map((entry) => {
    const usersForEntry = matchingUsers.filter((user) => userMatchesEntry(user, entry));
    const hasAcceptedInvitation = acceptedInvitations.some((invitation) =>
      invitationMatchesEntry(invitation.email, entry),
    );

    return {
      ...entry,
      accepted: usersForEntry.length > 0 || hasAcceptedInvitation,
      deployed: usersForEntry.some((user) => deployedUserIds.has(user.id)),
    };
  });
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
): Promise<ReadonlyArray<PlatformEvent>> {
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
): Promise<ReadonlyArray<PlatformEvent>> {
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
    .where(
      and(
        sql`lower(${invitations.email}) = ${email.toLowerCase()}`,
        eq(invitations.status, 'pending'),
      ),
    );
}

export async function getAllInvitations(
  db: Db,
  limit: number,
  offset: number,
): Promise<
  ReadonlyArray<Invitation & { invited_by_login: string | null; revoked_by_login: string | null }>
> {
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
  options?: {
    cliState?: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
  },
): Promise<void> {
  await db.insert(authCodes).values({
    code,
    jwt,
    cli_state: options?.cliState,
    code_challenge: options?.codeChallenge,
    code_challenge_method: options?.codeChallengeMethod,
    expires_at: sql`now() + ${String(ttlSeconds)} * interval '1 second'`,
  });
}

/** Atomically consume an auth code — returns the JWT if valid, null otherwise. */
export async function consumeAuthCode(db: Db, code: string): Promise<string | null> {
  const rows = await db
    .delete(authCodes)
    .where(
      and(
        eq(authCodes.code, code),
        isNull(authCodes.cli_state),
        isNull(authCodes.code_challenge),
        isNull(authCodes.code_challenge_method),
        sql`expires_at > now()`,
      ),
    )
    .returning({ jwt: authCodes.jwt });
  return rows[0]?.jwt ?? null;
}

/** Atomically consume a CLI auth code after matching its PKCE challenge. */
export async function consumeCliAuthCode(
  db: Db,
  code: string,
  state: string,
  codeChallenge: string,
  codeChallengeMethod: string,
): Promise<string | null> {
  const rows = await db
    .delete(authCodes)
    .where(
      and(
        eq(authCodes.code, code),
        eq(authCodes.cli_state, state),
        eq(authCodes.code_challenge, codeChallenge),
        eq(authCodes.code_challenge_method, codeChallengeMethod),
        sql`expires_at > now()`,
      ),
    )
    .returning({ jwt: authCodes.jwt });
  return rows[0]?.jwt ?? null;
}

/** Delete expired auth codes left behind by abandoned login flows. */
export async function purgeExpiredAuthCodes(db: Db): Promise<void> {
  await db.delete(authCodes).where(sql`expires_at <= now()`);
}
