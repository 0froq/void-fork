import type { User, Project, Deployment, Resource, Domain } from "./types";
import { generateId } from "./id";

// --- Users ---

export async function createUser(
  db: D1Database,
  provider: string,
  providerId: string,
  login: string,
  email: string | null,
): Promise<User> {
  const id = generateId("user");
  await db
    // github_id/github_login are ghost columns from the pre-migration schema (NOT NULL, can't drop)
    .prepare(
      "INSERT INTO users (id, provider, provider_id, login, email, github_id, github_login) VALUES (?, ?, ?, ?, ?, ABS(RANDOM()), ?)",
    )
    .bind(id, provider, providerId, login, email, login)
    .run();
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
  db: D1Database,
  provider: string,
  providerId: string,
): Promise<User | null> {
  return db
    .prepare("SELECT * FROM users WHERE provider = ? AND provider_id = ?")
    .bind(provider, providerId)
    .first<User>();
}

export async function getUserByEmail(db: D1Database, email: string): Promise<User | null> {
  return db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<User>();
}

export async function getUser(db: D1Database, id: string): Promise<User | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<User>();
}

export async function updateUser(
  db: D1Database,
  id: string,
  login: string,
  email: string | null,
): Promise<void> {
  await db
    .prepare("UPDATE users SET login = ?, github_login = ?, email = ? WHERE id = ?")
    .bind(login, login, email, id)
    .run();
}

export async function updateUserPlan(db: D1Database, id: string, plan: string): Promise<void> {
  await db.prepare("UPDATE users SET plan = ? WHERE id = ?").bind(plan, id).run();
}

export async function countUserDeploymentsToday(db: D1Database, userId: string): Promise<number> {
  const result = await db
    .prepare(
      `SELECT COUNT(*) as count FROM deployments d
       JOIN projects p ON d.project_id = p.id
       WHERE p.user_id = ? AND d.created_at >= date('now')`,
    )
    .bind(userId)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

// --- Projects ---

export async function createProject(
  db: D1Database,
  userId: string,
  slug: string,
  name: string,
): Promise<Project> {
  const id = generateId("proj");
  await db
    .prepare("INSERT INTO projects (id, user_id, slug, name) VALUES (?, ?, ?, ?)")
    .bind(id, userId, slug, name)
    .run();
  return {
    id,
    user_id: userId,
    slug,
    name,
    mode: "fullstack",
    created_at: new Date().toISOString(),
  };
}

export async function getProject(db: D1Database, id: string): Promise<Project | null> {
  return db.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first<Project>();
}

export async function getProjectBySlug(db: D1Database, slug: string): Promise<Project | null> {
  return db.prepare("SELECT * FROM projects WHERE slug = ?").bind(slug).first<Project>();
}

export async function getProjectsByUserId(db: D1Database, userId: string): Promise<Project[]> {
  const result = await db
    .prepare("SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC")
    .bind(userId)
    .all<Project>();
  return result.results;
}

export async function updateProjectMode(db: D1Database, id: string, mode: string): Promise<void> {
  await db.prepare("UPDATE projects SET mode = ? WHERE id = ?").bind(mode, id).run();
}

// --- Deployments ---

export async function createDeployment(
  db: D1Database,
  projectId: string,
  manifest: string | null,
  source?: string | null,
): Promise<Deployment> {
  const id = generateId("dpl");
  await db
    .prepare("INSERT INTO deployments (id, project_id, manifest, source) VALUES (?, ?, ?, ?)")
    .bind(id, projectId, manifest, source ?? null)
    .run();
  return {
    id,
    project_id: projectId,
    status: "pending",
    source: source ?? null,
    manifest,
    created_at: new Date().toISOString(),
    deployed_at: null,
  };
}

export async function updateDeploymentStatus(
  db: D1Database,
  id: string,
  status: Deployment["status"],
): Promise<void> {
  const deployedAt = status === "live" ? new Date().toISOString() : null;
  await db
    .prepare(
      "UPDATE deployments SET status = ?, deployed_at = COALESCE(?, deployed_at) WHERE id = ?",
    )
    .bind(status, deployedAt, id)
    .run();
}

export async function getDeployment(db: D1Database, id: string): Promise<Deployment | null> {
  return db.prepare("SELECT * FROM deployments WHERE id = ?").bind(id).first<Deployment>();
}

export async function getProjectDeployments(
  db: D1Database,
  projectId: string,
  limit = 5,
): Promise<Deployment[]> {
  const result = await db
    .prepare("SELECT * FROM deployments WHERE project_id = ? ORDER BY created_at DESC LIMIT ?")
    .bind(projectId, limit)
    .all<Deployment>();
  return result.results;
}

export async function getAllDeploymentsWithProject(
  db: D1Database,
  limit: number,
  offset: number,
): Promise<(Deployment & { project_slug: string | null; project_name: string | null })[]> {
  const result = await db
    .prepare(
      "SELECT d.*, p.slug as project_slug, p.name as project_name FROM deployments d LEFT JOIN projects p ON d.project_id = p.id ORDER BY d.created_at DESC LIMIT ? OFFSET ?",
    )
    .bind(limit, offset)
    .all<Deployment & { project_slug: string | null; project_name: string | null }>();
  return result.results;
}

export async function countDeployments(db: D1Database): Promise<number> {
  const result = await db
    .prepare("SELECT COUNT(*) as count FROM deployments")
    .first<{ count: number }>();
  return result?.count ?? 0;
}

// --- Resources ---

export async function createResource(
  db: D1Database,
  projectId: string,
  type: Resource["type"],
  cfId: string,
  bindingName: string,
): Promise<Resource> {
  const id = generateId("res");
  await db
    .prepare(
      "INSERT INTO resources (id, project_id, type, cf_id, binding_name) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id, projectId, type, cfId, bindingName)
    .run();
  return {
    id,
    project_id: projectId,
    type,
    cf_id: cfId,
    binding_name: bindingName,
    created_at: new Date().toISOString(),
  };
}

export async function getProjectResources(db: D1Database, projectId: string): Promise<Resource[]> {
  const result = await db
    .prepare("SELECT * FROM resources WHERE project_id = ?")
    .bind(projectId)
    .all<Resource>();
  return result.results;
}

// --- Domains ---

export async function createDomain(
  db: D1Database,
  projectId: string,
  hostname: string,
  cfHostnameId: string,
): Promise<Domain> {
  const id = generateId("dom");
  await db
    .prepare("INSERT INTO domains (id, project_id, hostname, cf_hostname_id) VALUES (?, ?, ?, ?)")
    .bind(id, projectId, hostname, cfHostnameId)
    .run();
  return {
    id,
    project_id: projectId,
    hostname,
    cf_hostname_id: cfHostnameId,
    status: "pending",
    created_at: new Date().toISOString(),
  };
}

export async function getDomainsByProjectId(db: D1Database, projectId: string): Promise<Domain[]> {
  const result = await db
    .prepare("SELECT * FROM domains WHERE project_id = ? ORDER BY created_at ASC")
    .bind(projectId)
    .all<Domain>();
  return result.results;
}

export async function getDomainByHostname(
  db: D1Database,
  hostname: string,
): Promise<Domain | null> {
  return db.prepare("SELECT * FROM domains WHERE hostname = ?").bind(hostname).first<Domain>();
}

export async function getDomain(db: D1Database, id: string): Promise<Domain | null> {
  return db.prepare("SELECT * FROM domains WHERE id = ?").bind(id).first<Domain>();
}

export async function updateDomainStatus(
  db: D1Database,
  id: string,
  status: string,
): Promise<void> {
  await db.prepare("UPDATE domains SET status = ? WHERE id = ?").bind(status, id).run();
}

export async function deleteDomain(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM domains WHERE id = ?").bind(id).run();
}

export async function deleteProjectDomains(db: D1Database, projectId: string): Promise<void> {
  await db.prepare("DELETE FROM domains WHERE project_id = ?").bind(projectId).run();
}

// --- Deletion ---

export async function deleteProjectResources(db: D1Database, projectId: string): Promise<void> {
  await db.prepare("DELETE FROM resources WHERE project_id = ?").bind(projectId).run();
}

export async function deleteProjectDeployments(db: D1Database, projectId: string): Promise<void> {
  await db.prepare("DELETE FROM deployments WHERE project_id = ?").bind(projectId).run();
}

export async function deleteProject(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM projects WHERE id = ?").bind(id).run();
}

// --- Counts ---

export async function countUsers(db: D1Database): Promise<number> {
  const result = await db.prepare("SELECT COUNT(*) as count FROM users").first<{ count: number }>();
  return result?.count ?? 0;
}

export async function countProjects(db: D1Database): Promise<number> {
  const result = await db
    .prepare("SELECT COUNT(*) as count FROM projects")
    .first<{ count: number }>();
  return result?.count ?? 0;
}

// --- Admin ---

export async function getAllUsers(db: D1Database, limit: number, offset: number): Promise<User[]> {
  const result = await db
    .prepare("SELECT * FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .bind(limit, offset)
    .all<User>();
  return result.results;
}

export async function searchUsers(db: D1Database, query: string): Promise<User[]> {
  const pattern = `%${query}%`;
  const result = await db
    .prepare(
      "SELECT * FROM users WHERE login LIKE ? OR email LIKE ? OR id LIKE ? ORDER BY created_at DESC LIMIT 50",
    )
    .bind(pattern, pattern, pattern)
    .all<User>();
  return result.results;
}

export async function getSystemStats(
  db: D1Database,
): Promise<{ users: number; projects: number; deployments: number }> {
  const [users, projects, deployments] = await db.batch([
    db.prepare("SELECT COUNT(*) as count FROM users"),
    db.prepare("SELECT COUNT(*) as count FROM projects"),
    db.prepare("SELECT COUNT(*) as count FROM deployments"),
  ]);
  return {
    users: (users.results[0] as { count: number }).count,
    projects: (projects.results[0] as { count: number }).count,
    deployments: (deployments.results[0] as { count: number }).count,
  };
}

export async function suspendUser(db: D1Database, id: string, reason: string): Promise<void> {
  await db.prepare("UPDATE users SET suspended_reason = ? WHERE id = ?").bind(reason, id).run();
}

export async function unsuspendUser(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE users SET suspended_reason = NULL WHERE id = ?").bind(id).run();
}

export async function updateUserRole(
  db: D1Database,
  id: string,
  role: "user" | "admin",
): Promise<void> {
  await db.prepare("UPDATE users SET role = ? WHERE id = ?").bind(role, id).run();
}

export async function getAllProjects(
  db: D1Database,
  limit: number,
  offset: number,
): Promise<Project[]> {
  const result = await db
    .prepare("SELECT * FROM projects ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .bind(limit, offset)
    .all<Project>();
  return result.results;
}

export async function getAllProjectsWithOwner(
  db: D1Database,
  limit: number,
  offset: number,
): Promise<(Project & { owner_login: string | null })[]> {
  const result = await db
    .prepare(
      "SELECT p.*, u.login as owner_login FROM projects p LEFT JOIN users u ON p.user_id = u.id ORDER BY p.created_at DESC LIMIT ? OFFSET ?",
    )
    .bind(limit, offset)
    .all<Project & { owner_login: string | null }>();
  return result.results;
}
