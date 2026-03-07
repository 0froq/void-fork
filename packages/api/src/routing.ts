import type { AssetConfig, DeployManifest } from "./types";

export function buildRoutingJson(opts: {
  workerName: string;
  projectId: string;
  userId: string;
  manifest: DeployManifest | null;
  deploymentId: string;
  dispatchLimits: { cpuMs?: number; subRequests?: number } | null;
  suspended?: string;
  hasCrons?: boolean;
}): string {
  const { manifest } = opts;
  return JSON.stringify({
    workerName: opts.workerName,
    projectId: opts.projectId,
    userId: opts.userId,
    ...(manifest?.ssr ? { ssr: true } : {}),
    ...(manifest?.revalidate ? { revalidate: manifest.revalidate } : {}),
    ...(manifest?.hashedAssetsPrefix ? { hashedAssetsPrefix: manifest.hashedAssetsPrefix } : {}),
    ...(manifest?.headerRules?.length ? { headerRules: manifest.headerRules } : {}),
    ...(manifest?.redirectRules?.length ? { redirectRules: manifest.redirectRules } : {}),
    version: opts.deploymentId,
    ...(opts.dispatchLimits ? { limits: opts.dispatchLimits } : {}),
    ...(opts.suspended ? { suspended: opts.suspended } : {}),
    ...(opts.hasCrons ? { hasCrons: true } : {}),
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
    assetConfig: opts.assetConfig,
    version: opts.deploymentId,
    ...(manifest?.hashedAssetsPrefix ? { hashedAssetsPrefix: manifest.hashedAssetsPrefix } : {}),
    ...(manifest?.headerRules?.length ? { headerRules: manifest.headerRules } : {}),
    ...(manifest?.redirectRules?.length ? { redirectRules: manifest.redirectRules } : {}),
    ...(opts.suspended ? { suspended: opts.suspended } : {}),
  });
}
