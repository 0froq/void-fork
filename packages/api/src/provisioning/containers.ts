import { CF_API_BASE, cfFetch } from './cloudflare-api';

export interface DurableObjectNamespaceInfo {
  id: string;
  class?: string;
  class_name?: string;
  name?: string;
  script?: string;
  script_name?: string;
}

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

export async function findDurableObjectNamespaceId(
  accountId: string,
  apiToken: string,
  scriptName: string,
  className: string,
): Promise<string> {
  const namespaces = await cfFetch<Array<DurableObjectNamespaceInfo>>(
    `${CF_API_BASE}/${accountId}/workers/durable_objects/namespaces`,
    apiToken,
  );

  const match = namespaces.find((namespace) => {
    const namespaceClass = namespace.class_name ?? namespace.class;
    const namespaceScript = namespace.script_name ?? namespace.script;
    return namespaceClass === className && namespaceScript === scriptName;
  });

  if (!match) {
    throw new Error(`Durable Object namespace not found for ${scriptName}/${className}`);
  }

  return match.id;
}

export async function upsertSandboxContainerApplication(
  accountId: string,
  apiToken: string,
  config: SandboxContainerConfig,
): Promise<ContainerApplicationInfo> {
  const existing = await findContainerApplication(accountId, apiToken, config.name);
  const requestBody = toContainerApplicationRequest(config);

  if (!existing) {
    return cfFetch<ContainerApplicationInfo>(`${containersUrl(accountId)}/applications`, apiToken, {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });
  }

  const existingNamespaceId = existing.durable_objects?.namespace_id;
  const changed =
    existing.configuration?.image !== config.image ||
    existing.configuration?.instance_type !== (config.instanceType ?? 'lite') ||
    existing.max_instances !== (config.maxInstances ?? 20) ||
    existingNamespaceId !== config.namespaceId;

  if (!changed) {
    return existing;
  }

  const updated = await cfFetch<ContainerApplicationInfo>(
    `${containersUrl(accountId)}/applications/${existing.id}`,
    apiToken,
    {
      method: 'PATCH',
      body: JSON.stringify(toContainerApplicationUpdateRequest(config)),
    },
  );

  await cfFetch(`${containersUrl(accountId)}/applications/${existing.id}/rollouts`, apiToken, {
    method: 'POST',
    body: JSON.stringify({ target_configuration: requestBody.configuration }),
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

function toContainerApplicationRequest(config: SandboxContainerConfig): Record<string, unknown> {
  return {
    name: config.name,
    scheduling_policy: 'default',
    configuration: {
      image: config.image,
      instance_type: config.instanceType ?? 'lite',
    },
    instances: 0,
    max_instances: config.maxInstances ?? 20,
    durable_objects: {
      namespace_id: config.namespaceId,
    },
    rollout_active_grace_period: 0,
  };
}

function toContainerApplicationUpdateRequest(
  config: SandboxContainerConfig,
): Record<string, unknown> {
  const { name: _name, instances: _instances, ...request } = toContainerApplicationRequest(config);
  return request;
}

function containersUrl(accountId: string): string {
  return `${CF_API_BASE}/${accountId}/containers`;
}
