import type { InferResponseType } from 'hono/client';
import { defineHandler } from 'void';
import { api, createClient, type API, type Client } from '../../lib/api.ts';

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
  const projectRes = await client.projects[':id'].$get({ param: { id } });
  if (!projectRes.ok) {
    return c.notFound();
  }

  const [project, deploymentsRes, domainsRes, resourcesRes, usageRes, secretsRes] =
    await Promise.all([
      projectRes.json(),
      client.projects[':id'].deployments.$get({ param: { id } }),
      client.projects[':id'].domains.$get({ param: { id } }),
      client.projects[':id'].resources.$get({ param: { id } }),
      client.projects[':id'].usage.$get({ param: { id } }),
      client.projects[':id'].secrets.$get({ param: { id } }),
    ]);

  return {
    project,
    deployments: deploymentsRes.ok
      ? await deploymentsRes.json()
      : { deployments: [], activeDeploymentId: project.active_deployment_id },
    domains: domainsRes.ok ? await domainsRes.json() : [],
    resources: resourcesRes.ok ? await resourcesRes.json() : [],
    usage: usageRes.ok
      ? ((await usageRes.json()) as Props['usage'])
      : {
          projectId: id,
          billingPeriodStart: new Date().toISOString(),
          requests: 0,
          bandwidthBytes: 0,
          aiNeurons: 0,
        },
    secrets: secretsRes.ok ? ((await secretsRes.json()) as Props['secrets']) : [],
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
