import { cfFetch, CF_API_BASE } from './cloudflare-api.ts';

export type WorkerVersion = {
  id: string;
  number: number;
  metadata: {
    created_on: string;
    author_email: string;
  };
};

export type DeploymentVersionEntry = {
  version_id: string;
  percentage: number;
};

export type WorkerDeployment = {
  id: string;
  versions: Array<DeploymentVersionEntry>;
  created_on: string;
  author_email: string;
};

export async function listWorkerVersions(
  accountId: string,
  apiToken: string,
  scriptName: string,
): Promise<{ items: Array<WorkerVersion> }> {
  return cfFetch<{ items: Array<WorkerVersion> }>(
    `${CF_API_BASE}/${accountId}/workers/scripts/${scriptName}/versions`,
    apiToken,
  );
}

export async function listWorkerDeployments(
  accountId: string,
  apiToken: string,
  scriptName: string,
): Promise<{ deployments: Array<WorkerDeployment> }> {
  return cfFetch<{ deployments: Array<WorkerDeployment> }>(
    `${CF_API_BASE}/${accountId}/workers/scripts/${scriptName}/deployments`,
    apiToken,
  );
}

export async function createWorkerDeployment(
  accountId: string,
  apiToken: string,
  scriptName: string,
  versionId: string,
): Promise<WorkerDeployment> {
  return cfFetch<WorkerDeployment>(
    `${CF_API_BASE}/${accountId}/workers/scripts/${scriptName}/deployments`,
    apiToken,
    {
      method: 'POST',
      body: JSON.stringify({
        strategy: 'percentage',
        versions: [{ version_id: versionId, percentage: 100 }],
      }),
    },
  );
}
