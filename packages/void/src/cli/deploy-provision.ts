/** The provision module, loaded lazily inside the Cloudflare fork only. */
type ProvisionModule = typeof import('./provision.ts');

export let loadedProvisionModule: ProvisionModule | undefined;

/**
 * Dynamically load the provision module (memoized). Called only from the async
 * Cloudflare fork (`runCloudflareDeploy` / `computeDesiredCloudflareResources`)
 * so a managed deploy never imports it — and thus never loads `proper-lockfile`.
 */
export async function loadProvisionModule(): Promise<ProvisionModule> {
  loadedProvisionModule ??= await import('./provision.ts');
  return loadedProvisionModule;
}

/**
 * The provision module after it has been loaded by the fork, for the SYNC helpers
 * (`resolveDeployTransport` / `deployChildEnv` / `createDeployWranglerRunner`)
 * that cannot await. They only ever run after {@link loadProvisionModule} has
 * resolved inside {@link runCloudflareDeploy}, so this never throws in practice.
 */
export function requireProvisionModule(): ProvisionModule {
  if (!loadedProvisionModule) {
    throw new Error('internal: provision module accessed before it was loaded');
  }
  return loadedProvisionModule;
}
