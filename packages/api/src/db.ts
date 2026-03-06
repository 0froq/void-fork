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
  or,
  sql,
  getTableColumns,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import {
  users,
  oauthAccounts,
  projects,
  deployments,
  resources,
  domains,
  platformEvents,
} from "./schema";
import { generateId } from "./id";
import type { PlanId } from "./tiers";
import type {
  Deployment,
  Domain,
  OAuthAccount,
  PlatformEvent,
  Project,
  Resource,
  User,
} from "./types";

export function createDb(connectionString: string) {
  return drizzle(connectionString, { schema });
}
export type Db = ReturnType<typeof createDb>;

// --- Users ---

export async function createUser(
  db: Db,
  provider: string,
  providerId: string,
  login: string,
  email: string | null,
): Promise<User> {
  const id = generateId("user");
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
  const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
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
  const id = generateId("oa");
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
  const id = generateId("proj");
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

export async function updateProjectType(db: Db, id: string, type: Project["type"]): Promise<void> {
  await db.update(projects).set({ type }).where(eq(projects.id, id));
}

// --- Deployments ---

export async function createDeployment(
  db: Db,
  projectId: string,
  manifest: string | null,
  source?: string | null,
  commit?: string | null,
): Promise<Deployment> {
  const id = generateId("dpl");
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
  status: Deployment["status"],
  errorMessage?: string,
): Promise<void> {
  await db
    .update(deployments)
    .set({
      status,
      deployed_at:
        status === "live"
          ? sql`COALESCE(${deployments.deployed_at}, now())`
          : sql`${deployments.deployed_at}`,
      error_message: sql`COALESCE(${errorMessage ?? null}, ${deployments.error_message})`,
    })
    .where(eq(deployments.id, id));
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

export async function getActiveDeployment(db: Db, projectId: string): Promise<Deployment | null> {
  const [row] = await db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.project_id, projectId),
        notInArray(deployments.status, ["live", "failed"]),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getLastLiveAssetManifest(
  db: Db,
  projectId: string,
): Promise<Record<string, { hash: string; size: number }> | null> {
  const [row] = await db
    .select({ asset_hashes: deployments.asset_hashes })
    .from(deployments)
    .where(and(eq(deployments.project_id, projectId), eq(deployments.status, "live")))
    .orderBy(desc(deployments.created_at))
    .limit(1);

  if (!row?.asset_hashes) return null;
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

// --- Resources ---

export async function createResource(
  db: Db,
  projectId: string,
  type: Resource["type"],
  cfId: string,
  bindingName: string,
): Promise<Resource> {
  const id = generateId("res");
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
  type: "d1" | "kv" | "r2" | "queue",
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
  const id = generateId("dom");
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
  status: Domain["status"],
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

export async function updateUserRole(db: Db, id: string, role: "user" | "admin"): Promise<void> {
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
      last_deploy: sql<string>`max(${deployments.created_at})`.as("last_deploy"),
      last_deploy_id:
        sql<string>`(SELECT id FROM deployments d2 WHERE d2.project_id = ${deployments.project_id} ORDER BY d2.created_at DESC LIMIT 1)`.as(
          "last_deploy_id",
        ),
      last_deploy_status:
        sql<string>`(SELECT status FROM deployments d3 WHERE d3.project_id = ${deployments.project_id} ORDER BY d3.created_at DESC LIMIT 1)`.as(
          "last_deploy_status",
        ),
    })
    .from(deployments)
    .groupBy(deployments.project_id)
    .as("last_deploy_sq");

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
      last_deploy: sql<string>`max(${deployments.created_at})`.as("last_deploy"),
      last_deploy_id:
        sql<string>`(SELECT id FROM deployments d2 WHERE d2.project_id = ${deployments.project_id} ORDER BY d2.created_at DESC LIMIT 1)`.as(
          "last_deploy_id",
        ),
      last_deploy_status:
        sql<string>`(SELECT status FROM deployments d3 WHERE d3.project_id = ${deployments.project_id} ORDER BY d3.created_at DESC LIMIT 1)`.as(
          "last_deploy_status",
        ),
    })
    .from(deployments)
    .groupBy(deployments.project_id)
    .as("last_deploy_sq");

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
    .where(eq(users.role, "admin"))
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

  if (userRows.length === 0) return [];

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
  event: Omit<PlatformEvent, "created_at">,
): Promise<PlatformEvent> {
  const [row] = await db.insert(platformEvents).values(event).returning();
  return row;
}

export async function updatePlatformEventStatus(
  db: Db,
  id: string,
  status: PlatformEvent["status"],
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
    .set({ status: "skipped" })
    .where(and(eq(platformEvents.batch_id, batchId), eq(platformEvents.status, "pending")));
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
  environment: PlatformEvent["environment"],
  limit = 20,
): Promise<PlatformEvent[]> {
  return db
    .select()
    .from(platformEvents)
    .where(eq(platformEvents.environment, environment))
    .orderBy(desc(platformEvents.created_at))
    .limit(limit);
}
