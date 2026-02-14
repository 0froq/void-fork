import type { User, Project, Deployment, Resource } from "./types";
import { generateId } from "./id";

// --- Users ---

export async function createUser(
  db: D1Database,
  githubId: number,
  githubLogin: string,
  email: string | null,
): Promise<User> {
  const id = generateId("user");
  await db
    .prepare("INSERT INTO users (id, github_id, github_login, email) VALUES (?, ?, ?, ?)")
    .bind(id, githubId, githubLogin, email)
    .run();
  return {
    id,
    github_id: githubId,
    github_login: githubLogin,
    email,
    created_at: new Date().toISOString(),
  };
}

export async function getUserByGithubId(db: D1Database, githubId: number): Promise<User | null> {
  return db.prepare("SELECT * FROM users WHERE github_id = ?").bind(githubId).first<User>();
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
  return { id, user_id: userId, slug, name, created_at: new Date().toISOString() };
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

// --- Deployments ---

export async function createDeployment(
  db: D1Database,
  projectId: string,
  manifest: string | null,
): Promise<Deployment> {
  const id = generateId("dpl");
  await db
    .prepare("INSERT INTO deployments (id, project_id, manifest) VALUES (?, ?, ?)")
    .bind(id, projectId, manifest)
    .run();
  return {
    id,
    project_id: projectId,
    status: "pending",
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
