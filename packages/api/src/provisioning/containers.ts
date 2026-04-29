import { CF_API_BASE, cfFetch } from './cloudflare-api.ts';

export interface ContainerApplicationInfo {
  id: string;
  name: string;
  scheduling_policy?: string;
  configuration?: {
    image?: string;
    instance_type?: string;
  };
  durable_objects?: {
    namespace_id?: string;
  };
  max_instances?: number;
}

export interface SandboxContainerConfig {
  name: string;
  image: string;
  namespaceId: string;
  instanceType?: string;
  maxInstances?: number;
}

interface ScriptBinding {
  type: string;
  name?: string;
  class_name?: string;
  namespace_id?: string;
}

/**
 * Resolve a Durable Object namespace ID for a class on a WfP script.
 *
 * Reads the script's own bindings (per-script endpoint) instead of paging the
 * account-wide `/workers/durable_objects/namespaces` listing. The listing
 * endpoint is global, doesn't accept a working `script` filter (CF ignores it
 * silently), and races against propagation lag for new WfP scripts. The
 * per-script bindings endpoint returns `namespace_id` directly the moment the
 * script is uploaded, so the caller's retry loop only ever waits for the
 * worker upload step itself to be visible — not for the global list to
 * eventually-consist.
 */
export async function findDurableObjectNamespaceId(
  accountId: string,
  apiToken: string,
  dispatchNamespace: string,
  scriptName: string,
  bindingName: string,
  className: string,
): Promise<string> {
  const bindings = await cfFetch<Array<ScriptBinding>>(
    `${CF_API_BASE}/${accountId}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${scriptName}/bindings`,
    apiToken,
  );

  const match = bindings.find(
    (binding) =>
      binding.type === 'durable_object_namespace' &&
      binding.name === bindingName &&
      binding.class_name === className &&
      typeof binding.namespace_id === 'string',
  );

  if (!match || !match.namespace_id) {
    throw new Error(
      `Durable Object namespace binding not found on ${dispatchNamespace}/${scriptName} for ${bindingName}=${className}`,
    );
  }

  return match.namespace_id;
}

/**
 * Find the container application that CF auto-created for a Sandbox class on
 * a WfP worker, and PATCH it to match the project's desired configuration.
 *
 * Cloudflare auto-creates the container application as a side-effect of the
 * worker upload's `containers: [{ class_name }]` metadata, binding it to the
 * DO namespace declared by the script's migration. The application is named
 * `proj-{projectId}-{containerName}` (matching this platform's convention,
 * because CF carries the previous app's name forward when the namespace is
 * recreated). Direct POST `/containers/applications` with `durable_objects`
 * is rejected by CF as `unrecognized key(s) in object: 'durable_objects'`,
 * so this code never POSTs — it locates the auto-created app and tunes its
 * configuration via PATCH.
 *
 * The PATCH body deliberately omits `durable_objects`. CF treats the binding
 * as immutable on the application; the namespace association is fixed by the
 * worker's containers metadata at upload time.
 */
export async function upsertSandboxContainerApplication(
  accountId: string,
  apiToken: string,
  config: SandboxContainerConfig,
): Promise<ContainerApplicationInfo> {
  const existing = await waitForAutoCreatedApplication(accountId, apiToken, config.name);

  const desiredImage = config.image;
  const desiredInstanceType = config.instanceType ?? 'lite';
  const desiredMaxInstances = config.maxInstances ?? 20;
  const changed =
    existing.configuration?.image !== desiredImage ||
    existing.configuration?.instance_type !== desiredInstanceType ||
    existing.max_instances !== desiredMaxInstances;

  if (!changed) {
    return existing;
  }

  const patchBody = {
    configuration: { image: desiredImage, instance_type: desiredInstanceType },
    max_instances: desiredMaxInstances,
    scheduling_policy: 'default',
    rollout_active_grace_period: 0,
  };
  const updated = await cfFetch<ContainerApplicationInfo>(
    `${containersUrl(accountId)}/applications/${existing.id}`,
    apiToken,
    {
      method: 'PATCH',
      body: JSON.stringify(patchBody),
    },
  );

  // POST rollout to apply the PATCHed configuration to running instances.
  // Body shape mirrors what wrangler sends (workers-sdk/packages/wrangler/src/
  // containers/deploy.ts and packages/containers-shared/src/client/models/
  // CreateApplicationRolloutRequest.ts). Required fields:
  //   - description: free-form string
  //   - strategy: only "rolling" is valid (lowercase)
  //   - target_configuration: the new configuration
  //   - step_percentage OR steps: rollout pacing (one is required); 100 = a
  //     single instant step, which is what we want for platform-driven config
  //     updates (no manual gating)
  //   - kind: optional; defaults to full_auto. We set it explicitly so a
  //     future API change can't surprise us with a manual-rollout default.
  await cfFetch(`${containersUrl(accountId)}/applications/${existing.id}/rollouts`, apiToken, {
    method: 'POST',
    body: JSON.stringify({
      description: 'void platform sandbox config update',
      strategy: 'rolling',
      target_configuration: patchBody.configuration,
      step_percentage: 100,
      kind: 'full_auto',
    }),
  });

  return updated;
}

export async function deleteContainerApplication(
  accountId: string,
  apiToken: string,
  applicationId: string,
): Promise<void> {
  await cfFetch(`${containersUrl(accountId)}/applications/${applicationId}`, apiToken, {
    method: 'DELETE',
  });
}

/**
 * Poll CF for the auto-created container application by name. The app is
 * created as a side-effect of the worker upload, but propagation to the
 * `?name=` listing endpoint can lag a few hundred ms.
 */
async function waitForAutoCreatedApplication(
  accountId: string,
  apiToken: string,
  name: string,
): Promise<ContainerApplicationInfo> {
  const delaysMs = [0, 250, 500, 1000, 2000, 4000];
  let lastErr: unknown;
  for (let attempt = 0; attempt < delaysMs.length; attempt++) {
    if (delaysMs[attempt] > 0) {
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
    try {
      const found = await findContainerApplication(accountId, apiToken, name);
      if (found) {
        return found;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `container application "${name}" was not auto-created by CF after worker upload${
      lastErr instanceof Error ? `: ${lastErr.message}` : ''
    }`,
  );
}

async function findContainerApplication(
  accountId: string,
  apiToken: string,
  name: string,
): Promise<ContainerApplicationInfo | undefined> {
  const applications = await cfFetch<Array<ContainerApplicationInfo>>(
    `${containersUrl(accountId)}/applications?name=${encodeURIComponent(name)}`,
    apiToken,
  );
  return applications.find((application) => application.name === name);
}

function containersUrl(accountId: string): string {
  return `${CF_API_BASE}/${accountId}/containers`;
}
