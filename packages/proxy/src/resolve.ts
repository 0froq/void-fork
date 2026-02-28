/**
 * Resolves a project's binding to its Cloudflare resource ID via the platform DB.
 *
 * Query: SELECT cf_id FROM resources WHERE project_id = ? AND type = ? AND binding_name = ?
 * The resources table has a unique constraint on (project_id, type, binding_name).
 */
export async function resolveResource(
  db: D1Database,
  projectId: string,
  type: "d1" | "kv" | "r2",
  bindingName: string,
): Promise<string> {
  const row = await db
    .prepare("SELECT cf_id FROM resources WHERE project_id = ? AND type = ? AND binding_name = ?")
    .bind(projectId, type, bindingName)
    .first<{ cf_id: string }>();

  if (!row) {
    throw new Error(`No ${type} resource "${bindingName}" found for project ${projectId}`);
  }
  return row.cf_id;
}
