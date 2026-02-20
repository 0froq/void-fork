import { and, count, desc, asc, eq, inArray, like, or, sql, getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
import { users, projects, deployments, resources, domains } from "./schema";
import { generateId } from "./id";
import type { PlanId } from "./tiers";
import type { Deployment, Domain, Project, Resource, User } from "./types";

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
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
  await db.insert(users).values({
    id,
    provider,
    provider_id: providerId,
    login,
    email,
    billing_cycle_start: new Date().toISOString(),
  });
  return {
    id,
    provider,
    provider_id: providerId,
    login,
    email,
    plan: "free",
    role: "user",
    billing_cycle_start: new Date().toISOString(),
    suspended_reason: null,
    created_at: new Date().toISOString(),
  };
}

export async function getUserByProvider(
  db: Db,
  provider: string,
  providerId: string,
): Promise<User | null> {
  return (
    (await db
      .select()
      .from(users)
      .where(and(eq(users.provider, provider), eq(users.provider_id, providerId)))
      .get()) ?? null
  );
}

export async function getUserByEmail(db: Db, email: string): Promise<User | null> {
  return (await db.select().from(users).where(eq(users.email, email)).get()) ?? null;
}

export async function getUser(db: Db, id: string): Promise<User | null> {
  return (await db.select().from(users).where(eq(users.id, id)).get()) ?? null;
}

export async function updateUser(
  db: Db,
  id: string,
  login: string,
  email: string | null,
): Promise<void> {
  await db.update(users).set({ login, email }).where(eq(users.id, id));
}

export async function updateUserPlan(db: Db, id: string, plan: PlanId): Promise<void> {
  await db.update(users).set({ plan }).where(eq(users.id, id));
}

export async function countUserDeploymentsToday(db: Db, userId: string): Promise<number> {
  const result = await db
    .select({ count: count() })
    .from(deployments)
    .innerJoin(projects, eq(deployments.project_id, projects.id))
    .where(and(eq(projects.user_id, userId), sql`${deployments.created_at} >= date('now')`))
    .get();
  return result?.count ?? 0;
}

// --- Projects ---

export async function createProject(db: Db, userId: string, slug: string): Promise<Project> {
  const id = generateId("proj");
  await db.insert(projects).values({ id, user_id: userId, slug });
  return {
    id,
    user_id: userId,
    slug,
    mode: "fullstack",
    created_at: new Date().toISOString(),
  };
}

export async function getProject(db: Db, id: string): Promise<Project | null> {
  return (await db.select().from(projects).where(eq(projects.id, id)).get()) ?? null;
}

export async function getProjectBySlug(db: Db, slug: string): Promise<Project | null> {
  return (await db.select().from(projects).where(eq(projects.slug, slug)).get()) ?? null;
}

export async function getProjectsByUserId(db: Db, userId: string): Promise<Project[]> {
  return db
    .select()
    .from(projects)
    .where(eq(projects.user_id, userId))
    .orderBy(desc(projects.created_at))
    .all();
}

export async function updateProjectMode(db: Db, id: string, mode: Project["mode"]): Promise<void> {
  await db.update(projects).set({ mode }).where(eq(projects.id, id));
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
  await db.insert(deployments).values({
    id,
    project_id: projectId,
    manifest,
    source: source ?? null,
    commit: commit ?? null,
  });
  return {
    id,
    project_id: projectId,
    status: "pending",
    source: source ?? null,
    commit: commit ?? null,
    manifest,
    error_message: null,
    created_at: new Date().toISOString(),
    deployed_at: null,
  };
}

export async function updateDeploymentStatus(
  db: Db,
  id: string,
  status: Deployment["status"],
  errorMessage?: string,
): Promise<void> {
  const deployedAt = status === "live" ? new Date().toISOString() : null;
  await db
    .update(deployments)
    .set({
      status,
      deployed_at: sql`COALESCE(${deployedAt}, ${deployments.deployed_at})`,
      error_message: sql`COALESCE(${errorMessage ?? null}, ${deployments.error_message})`,
    })
    .where(eq(deployments.id, id));
}

export async function getDeployment(db: Db, id: string): Promise<Deployment | null> {
  return (await db.select().from(deployments).where(eq(deployments.id, id)).get()) ?? null;
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
    .limit(limit)
    .all();
}

export async function getAllDeploymentsWithProject(
  db: Db,
  limit: number,
  offset: number,
): Promise<(Deployment & { project_slug: string | null })[]> {
  return db
    .select({ ...getTableColumns(deployments), project_slug: projects.slug })
    .from(deployments)
    .leftJoin(projects, eq(deployments.project_id, projects.id))
    .orderBy(desc(deployments.created_at))
    .limit(limit)
    .offset(offset)
    .all();
}

export async function countDeployments(db: Db): Promise<number> {
  const result = await db.select({ count: count() }).from(deployments).get();
  return result?.count ?? 0;
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
  await db
    .insert(resources)
    .values({ id, project_id: projectId, type, cf_id: cfId, binding_name: bindingName });
  return {
    id,
    project_id: projectId,
    type,
    cf_id: cfId,
    binding_name: bindingName,
    created_at: new Date().toISOString(),
  };
}

export async function getProjectResources(db: Db, projectId: string): Promise<Resource[]> {
  return db.select().from(resources).where(eq(resources.project_id, projectId)).all();
}

// --- Domains ---

export async function createDomain(
  db: Db,
  projectId: string,
  hostname: string,
  cfHostnameId: string,
): Promise<Domain> {
  const id = generateId("dom");
  await db
    .insert(domains)
    .values({ id, project_id: projectId, hostname, cf_hostname_id: cfHostnameId });
  return {
    id,
    project_id: projectId,
    hostname,
    cf_hostname_id: cfHostnameId,
    status: "pending",
    created_at: new Date().toISOString(),
  };
}

export async function getDomainsByProjectId(db: Db, projectId: string): Promise<Domain[]> {
  return db
    .select()
    .from(domains)
    .where(eq(domains.project_id, projectId))
    .orderBy(asc(domains.created_at))
    .all();
}

export async function getDomainByHostname(db: Db, hostname: string): Promise<Domain | null> {
  return (await db.select().from(domains).where(eq(domains.hostname, hostname)).get()) ?? null;
}

export async function getDomain(db: Db, id: string): Promise<Domain | null> {
  return (await db.select().from(domains).where(eq(domains.id, id)).get()) ?? null;
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

// --- Counts ---

export async function countUsers(db: Db): Promise<number> {
  const result = await db.select({ count: count() }).from(users).get();
  return result?.count ?? 0;
}

export async function countProjects(db: Db): Promise<number> {
  const result = await db.select({ count: count() }).from(projects).get();
  return result?.count ?? 0;
}

// --- Admin ---

export async function getAllUsers(db: Db, limit: number, offset: number): Promise<User[]> {
  return db.select().from(users).orderBy(desc(users.created_at)).limit(limit).offset(offset).all();
}

export async function searchUsers(db: Db, query: string): Promise<User[]> {
  const pattern = `%${query}%`;
  return db
    .select()
    .from(users)
    .where(or(like(users.login, pattern), like(users.email, pattern), like(users.id, pattern)))
    .orderBy(desc(users.created_at))
    .limit(50)
    .all();
}

export async function getSystemStats(
  db: Db,
): Promise<{ users: number; projects: number; deployments: number }> {
  const [u, p, d] = await Promise.all([
    db.select({ count: count() }).from(users).get(),
    db.select({ count: count() }).from(projects).get(),
    db.select({ count: count() }).from(deployments).get(),
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

export async function getAllProjects(db: Db, limit: number, offset: number): Promise<Project[]> {
  return db
    .select()
    .from(projects)
    .orderBy(desc(projects.created_at))
    .limit(limit)
    .offset(offset)
    .all();
}

export async function getAllProjectsWithOwner(
  db: Db,
  limit: number,
  offset: number,
): Promise<(Project & { owner_login: string | null })[]> {
  return db
    .select({ ...getTableColumns(projects), owner_login: users.login })
    .from(projects)
    .leftJoin(users, eq(projects.user_id, users.id))
    .orderBy(desc(projects.created_at))
    .limit(limit)
    .offset(offset)
    .all();
}

// --- Consolidated queries (previously inline) ---

export async function getFirstAdmin(db: Db) {
  return (
    (await db
      .select({ id: users.id, login: users.login })
      .from(users)
      .where(eq(users.role, "admin"))
      .limit(1)
      .get()) ?? null
  );
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
    .from(users)
    .all();
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
    .offset(offset)
    .all();

  if (userRows.length === 0) return [];

  const userIds = userRows.map((u) => u.id);
  const projectRows = await db
    .select({ id: projects.id, slug: projects.slug, user_id: projects.user_id })
    .from(projects)
    .where(inArray(projects.user_id, userIds))
    .all();

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
