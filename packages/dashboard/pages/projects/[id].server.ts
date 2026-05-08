import type { InferResponseType } from 'hono/client';
import { defineHandler } from 'void';
import {
  api,
  createClient,
  readApiJson,
  type API,
  type ApiResponse,
  type Client,
} from '../../lib/api.ts';

type ProjectRoutes = Client['projects'][':id'];

export type Props = {
  project: InferResponseType<ProjectRoutes['$get'], 200>;
  deployments: InferResponseType<ProjectRoutes['deployments']['$get'], 200>;
  domains: InferResponseType<ProjectRoutes['domains']['$get'], 200>;
  resources: InferResponseType<ProjectRoutes['resources']['$get'], 200>;
  usage: API<'usage', ProjectRoutes>;
  secrets: API<'secrets', ProjectRoutes>;
  siteDomain: string;
};

export const loader = defineHandler<Props>(async (c) => {
  const id = c.req.param('id');
  if (!id) {
    return c.notFound();
  }

  const client = createClient(c);
  let projectRes: ApiResponse;
  try {
    projectRes = await client.projects[':id'].$get({ param: { id } });
  } catch (error) {
    console.warn(
      `[dashboard] /projects/${id} request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return c.notFound();
  }

  if (!projectRes.ok) {
    return c.notFound();
  }
  const project = await readApiJson<Props['project']>(projectRes);
  if (!project) {
    return c.notFound();
  }

  const [deploymentsRes, domainsRes, resourcesRes, usageRes, secretsRes] = await Promise.allSettled(
    [
      client.projects[':id'].deployments.$get({ param: { id } }),
      client.projects[':id'].domains.$get({ param: { id } }),
      client.projects[':id'].resources.$get({ param: { id } }),
      client.projects[':id'].usage.$get({ param: { id } }),
      client.projects[':id'].secrets.$get({ param: { id } }),
    ],
  );

  const readSettled = async <T>(result: PromiseSettledResult<ApiResponse>): Promise<T | null> => {
    if (result.status === 'rejected') {
      console.warn(
        `[dashboard] project detail API request failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      );
      return null;
    }
    return result.value.ok ? readApiJson<T>(result.value) : null;
  };

  return {
    project,
    deployments: (await readSettled<Props['deployments']>(deploymentsRes)) ?? {
      deployments: [],
      activeDeploymentId: project.active_deployment_id,
    },
    domains: (await readSettled<Props['domains']>(domainsRes)) ?? [],
    resources: (await readSettled<Props['resources']>(resourcesRes)) ?? [],
    usage: (await readSettled<Props['usage']>(usageRes)) ?? {
      projectId: id,
      billingPeriodStart: new Date().toISOString(),
      requests: 0,
      bandwidthBytes: 0,
      aiNeurons: 0,
    },
    secrets: (await readSettled<Props['secrets']>(secretsRes)) ?? [],
    siteDomain: (c.env as Record<string, string>).SITE_DOMAIN ?? 'void.app',
  };
});

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export const action = defineHandler(async (c) => {
  const id = c.req.param('id');
  if (!id) {
    return c.notFound();
  }

  const form = await c.req.parseBody();
  const intent = stringValue(form._intent);

  if (intent === 'add-domain') {
    await api(c, `/projects/${id}/domains`, {
      method: 'POST',
      body: JSON.stringify({ hostname: stringValue(form.hostname).trim() }),
    });
  } else if (intent === 'remove-domain') {
    await api(c, `/projects/${id}/domains/${stringValue(form.domainId)}`, {
      method: 'DELETE',
    });
  } else if (intent === 'add-secret') {
    await api(c, `/projects/${id}/secrets/${stringValue(form.name).trim()}`, {
      method: 'PUT',
      body: JSON.stringify({ value: stringValue(form.value) }),
    });
  } else if (intent === 'remove-secret') {
    await api(c, `/projects/${id}/secrets/${stringValue(form.name)}`, {
      method: 'DELETE',
    });
  }

  return c.redirect(`/projects/${id}`);
});
