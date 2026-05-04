import { CF_API_BASE, cfFetch, CloudflareApiError } from './cloudflare-api.ts';

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
 * Idempotent variant of {@link deleteContainerApplication}. Swallows 404
 * responses (the application is already gone) and re-throws any other error.
 * Used by `provisionSandboxHost` and project teardown to make repeated DELETE
 * attempts safe under partial-failure replay.
 */
export async function deleteContainerApplicationIdempotent(
  accountId: string,
  apiToken: string,
  applicationId: string,
): Promise<void> {
  try {
    await deleteContainerApplication(accountId, apiToken, applicationId);
  } catch (err) {
    if (err instanceof CloudflareApiError && err.status === 404) {
      return;
    }
    throw err;
  }
}

/**
 * POST a new container application. Returns the created app on success, or
 * `undefined` if CF reports the app already exists (i.e. a concurrent deploy
 * won the race) so the caller can fall back to PATCH. Any other error
 * propagates.
 *
 * Status 409 is the authoritative race signal; message matching is a
 * defense-in-depth fallback for non-conventional responses where CF returns a
 * different status but the body still says "already exists".
 */
export async function tryCreateContainerApplication(
  accountId: string,
  apiToken: string,
  config: SandboxContainerConfig,
): Promise<ContainerApplicationInfo | undefined> {
  const createBody = {
    name: config.name,
    scheduling_policy: 'default',
    configuration: {
      image: config.image,
      instance_type: config.instanceType ?? 'lite',
    },
    instances: 0,
    max_instances: config.maxInstances ?? 20,
    durable_objects: { namespace_id: config.namespaceId },
    rollout_active_grace_period: 0,
  };

  try {
    return await cfFetch<ContainerApplicationInfo>(
      `${containersUrl(accountId)}/applications`,
      apiToken,
      {
        method: 'POST',
        body: JSON.stringify(createBody),
      },
    );
  } catch (err) {
    // Authoritative: HTTP 409 means concurrent-create race regardless of body.
    if (err instanceof CloudflareApiError && err.status === 409) {
      return undefined;
    }
    // Defense-in-depth: some CF endpoints return non-409 statuses but still
    // signal the conflict in the message body.
    if (err instanceof Error && isAlreadyExistsError(err.message)) {
      return undefined;
    }
    throw err;
  }
}

// Intentionally does not match the bare word 'conflict' — it appears in unrelated CF validation errors (e.g. "configuration conflicts with durable object namespace") and would cause a false-positive race fallback.
function isAlreadyExistsError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('already exists') || lower.includes('duplicate');
}

export async function findContainerApplication(
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
