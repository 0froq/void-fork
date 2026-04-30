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

/**
 * Provision (create or update) the Cloudflare container application that
 * backs a project's Sandbox Durable Object class on a WfP worker.
 *
 * Cloudflare does NOT auto-create container applications from a worker's
 * `containers: [{ class_name }]` upload metadata. Wrangler is the canonical
 * implementation: it lists applications, POSTs `/containers/applications`
 * when the app is missing, and PATCHes when it exists. See
 * `workers-sdk/packages/wrangler/src/containers/deploy.ts` (`apply` +
 * `containerConfigToCreateRequest`) for the reference flow.
 *
 * The POST body matches `CreateApplicationRequest` from
 * `workers-sdk/packages/containers-shared/src/client/models/CreateApplicationRequest.ts`,
 * including `durable_objects: { namespace_id }` to bind the application to
 * the Sandbox class's DO namespace. A previous attempt to interpret a CF
 * rejection as "POST not allowed; the app is auto-created" was wrong — that
 * rejection was almost certainly a transient referential failure when the DO
 * namespace had not yet propagated. By the time we POST here,
 * `findDurableObjectNamespaceId` has already confirmed the namespace exists
 * by reading the script's bindings, so the POST is safe.
 *
 * The PATCH body deliberately omits `durable_objects` and `name` because
 * neither field is part of `ModifyApplicationRequestBody`
 * (`workers-sdk/packages/containers-shared/src/client/models/ModifyApplicationRequestBody.ts`).
 * The DO namespace binding is set on POST and is not modifiable afterwards.
 *
 * Concurrency: if a parallel deploy created the app between our find and our
 * POST, CF returns a 409 / "already exists" style error. We treat that as a
 * race and re-find + fall through to the PATCH branch.
 *
 * Before modifying an existing application, we verify it is bound to the
 * expected DO namespace; mismatch fails loudly because the binding is
 * immutable on PATCH. Without this check, a stale or manually-created app
 * with the same name but a different `durable_objects.namespace_id` would
 * be silently PATCHed (PATCH omits `durable_objects`), the deploy would
 * appear successful, and runtime traffic would route to the wrong DO
 * namespace. See `workers-sdk/packages/wrangler/src/containers/deploy.ts`
 * for wrangler's equivalent assertion.
 *
 * Rollout: matches wrangler — only PATCH triggers a rollout. Initial POST
 * boots the application into its starting configuration directly.
 */
export async function upsertSandboxContainerApplication(
  accountId: string,
  apiToken: string,
  config: SandboxContainerConfig,
): Promise<ContainerApplicationInfo> {
  let existing = await findContainerApplication(accountId, apiToken, config.name);

  if (!existing) {
    const created = await tryCreateContainerApplication(accountId, apiToken, config);
    if (created) {
      return created;
    }
    // POST raced with another deploy that created the app first. Re-find
    // and fall through to the PATCH branch so we still reconcile config.
    existing = await findContainerApplication(accountId, apiToken, config.name);
    if (!existing) {
      throw new Error(
        `container application "${config.name}" reported as already-existing but could not be located on re-find`,
      );
    }
  }

  assertNamespaceMatch(existing, config);

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
 * POST a new container application. Returns the created app on success, or
 * `undefined` if CF reports the app already exists (i.e. a concurrent deploy
 * won the race) so the caller can fall back to PATCH. Any other error
 * propagates.
 *
 * Status 409 is the authoritative race signal; message matching is a
 * defense-in-depth fallback for non-conventional responses where CF returns a
 * different status but the body still says "already exists".
 */
async function tryCreateContainerApplication(
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

/**
 * Verify that an existing container application is bound to the DO namespace
 * we expect. PATCH cannot rebind `durable_objects.namespace_id` — that field
 * is set on POST and is immutable afterwards (see
 * `workers-sdk/packages/containers-shared/src/client/models/ModifyApplicationRequestBody.ts`).
 *
 * If a same-name app exists with a missing or different namespace_id (stale,
 * manually-created, or rotated), we must fail loudly rather than silently
 * PATCH config onto an app that will keep routing traffic to the wrong DO
 * namespace. The only remediation is deleting the existing application so
 * the next deploy can POST a fresh one with the correct binding.
 */
function assertNamespaceMatch(
  existing: ContainerApplicationInfo,
  config: SandboxContainerConfig,
): void {
  const actual = existing.durable_objects?.namespace_id;
  if (actual === config.namespaceId) {
    return;
  }
  throw new Error(
    `container application "${config.name}" is bound to a different durable object namespace ` +
      `(expected ${config.namespaceId}, found ${actual ?? 'none'}). ` +
      `The DO namespace binding is immutable on PATCH; delete the existing application before redeploying to rebind it.`,
  );
}

// Intentionally does not match the bare word 'conflict' — it appears in unrelated CF validation errors (e.g. "configuration conflicts with durable object namespace") and would cause a false-positive race fallback.
function isAlreadyExistsError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('already exists') || lower.includes('duplicate');
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
