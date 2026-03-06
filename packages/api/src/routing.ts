import type { DeployManifest } from "./types";

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
