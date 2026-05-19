import { getProjectsByUserId, getUser, type Db } from './db.ts';
import type { AssetConfig, DeployManifest } from './types.ts';

/**
 * KV key + payload shape for the per-project routing entry consumed by the
 * proxy's `/sandbox/acquire` lookup (`packages/proxy/src/sandbox.ts`). The
 * proxy parses `{ userId, plan }` to resolve the sandbox concurrency cap +
 * runtime-block lookup for the authenticated `projectId`. Field casing is
 * camelCase to match the rest of the routing-entry conventions in this
 * module — `buildRoutingJson` and `buildStaticRoutingJson` both emit
 * `projectId` / `userId`.
 */
export type ProjectAccountEntry = Readonly<{
  userId: string;
  plan: string;
}>;

export function projectAccountKey(projectId: string): string {
  return `project:${projectId}`;
}

export function sandboxBlockKey(userId: string): string {
  return `sandbox-block:${userId}`;
}

export function buildProjectAccountJson(entry: ProjectAccountEntry): string {
  return JSON.stringify({ userId: entry.userId, plan: entry.plan });
}

/**
 * Write the per-project routing entry the proxy's sandbox gate reads.
 * Called from every deploy's routing-switch step so a plan-change picked up
 * by `provisionBindings` propagates to the proxy without a separate write.
 */
export async function writeProjectAccountEntry(
  routing: KVNamespace,
  projectId: string,
  userId: string,
  plan: string,
): Promise<void> {
  await routing.put(projectAccountKey(projectId), buildProjectAccountJson({ userId, plan }));
}

/**
 * Re-publish every `project:{projectId}` routing entry for `userId`. Invoked
 * after a plan-change so the proxy's sandbox gate sees the new concurrency
 * cap on the next acquire without waiting for the user to redeploy. Best-
 * effort: KV writes are idempotent and bounded by the user's project count,
 * but a failure here means stale plan data lives in KV until the next deploy
 * for that project — callers should log on failure.
 */
export async function refreshProjectKvForUser(
  db: Db,
  routing: KVNamespace,
  userId: string,
): Promise<void> {
  const user = await getUser(db, userId);
  if (!user) {
    return;
  }
  const projects = await getProjectsByUserId(db, userId);
  if (projects.length === 0) {
    return;
  }
  const payload = buildProjectAccountJson({ userId, plan: user.plan });
  await Promise.all(projects.map((project) => routing.put(projectAccountKey(project.id), payload)));
}

export function buildRoutingJson(opts: {
  workerName: string;
  projectId: string;
  userId: string;
  manifest: DeployManifest | null;
  deploymentId: string;
  dispatchLimits: { cpuMs?: number; subRequests?: number } | null;
  suspended?: string;
  hasCrons?: boolean;
  assetManifestId?: string;
  assetConfig?: AssetConfig;
}): string {
  const { manifest } = opts;
  return JSON.stringify({
    workerName: opts.workerName,
    projectId: opts.projectId,
    userId: opts.userId,
    type: manifest?.type ?? (manifest?.framework ? 'framework' : 'void'),
    ...(manifest?.ssr ? { ssr: true } : {}),
    ...(manifest?.revalidate ? { revalidate: manifest.revalidate } : {}),
    ...(manifest?.hashedAssetsPrefix ? { hashedAssetsPrefix: manifest.hashedAssetsPrefix } : {}),
    ...(manifest?.headerRules?.length ? { headerRules: manifest.headerRules } : {}),
    ...(manifest?.redirectRules?.length ? { redirectRules: manifest.redirectRules } : {}),
    ...(manifest?.fallbackRules?.length ? { fallbackRules: manifest.fallbackRules } : {}),
    ...(manifest?.revalidateQueryAllowlist
      ? { queryAllowlist: manifest.revalidateQueryAllowlist }
      : {}),
    version: opts.deploymentId,
    ...(opts.dispatchLimits ? { limits: opts.dispatchLimits } : {}),
    ...(opts.suspended ? { suspended: opts.suspended } : {}),
    ...(opts.hasCrons ? { hasCrons: true } : {}),
    ...(opts.assetManifestId ? { assetManifestId: opts.assetManifestId } : {}),
    ...(opts.assetConfig ? { assetConfig: opts.assetConfig } : {}),
  });
}

export function buildStaticRoutingJson(opts: {
  projectId: string;
  userId: string;
  deploymentId: string;
  assetConfig: AssetConfig;
  manifest: DeployManifest | null;
  suspended?: string;
}): string {
  const { manifest } = opts;
  return JSON.stringify({
    staticDeploymentId: opts.deploymentId,
    projectId: opts.projectId,
    userId: opts.userId,
    type: manifest?.type ?? 'static',
    assetConfig: opts.assetConfig,
    version: opts.deploymentId,
    ...(manifest?.hashedAssetsPrefix ? { hashedAssetsPrefix: manifest.hashedAssetsPrefix } : {}),
    ...(manifest?.headerRules?.length ? { headerRules: manifest.headerRules } : {}),
    ...(manifest?.redirectRules?.length ? { redirectRules: manifest.redirectRules } : {}),
    ...(manifest?.fallbackRules?.length ? { fallbackRules: manifest.fallbackRules } : {}),
    ...(manifest?.revalidateQueryAllowlist
      ? { queryAllowlist: manifest.revalidateQueryAllowlist }
      : {}),
    ...(opts.suspended ? { suspended: opts.suspended } : {}),
  });
}
