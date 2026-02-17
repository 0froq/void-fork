import type { User, Project, Deployment, Resource } from "./types";
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
