import { defineHandler } from "vite-cloud";
import { createClient, api, type API, type Client } from "../../lib/api";

type P = Client["projects"][":id"];

export type Props = {
  project: API<"$get", P> & { custom_domain: string | null };
  deployments: API<"deployments", P>;
  usage: API<"usage", P>;
  domains: API<"domains", P>;
  secrets: API<"secrets", P>;
  resources: API<"resources", P>;
};

export const loader = defineHandler<Props>(async (c) => {
  const id = c.req.param("id");
  const client = createClient(c);

  const projectRes = await client.projects[":id"].$get({ param: { id } });
  if (!projectRes.ok) {
    if (projectRes.status === 404) return c.notFound();
    throw new Error(await projectRes.text());
  }
  const project = (await projectRes.json()) as API<"$get", P>;

  const [deploymentsRes, usageRes, domainsRes, secretsRes, resourcesRes] = await Promise.all([
    client.projects[":id"].deployments.$get({ param: { id } }),
    client.projects[":id"].usage.$get({ param: { id } }),
    client.projects[":id"].domains.$get({ param: { id } }),
    client.projects[":id"].secrets.$get({ param: { id } }),
    client.projects[":id"].resources.$get({ param: { id } }),
  ]);

  const [deployments, usage, domains, secrets, resources] = await Promise.all([
    deploymentsRes.json() as Promise<Props["deployments"]>,
    usageRes.ok
      ? (usageRes.json() as Promise<Props["usage"]>)
      : {
          projectId: id,
          billingPeriodStart: new Date().toISOString(),
          requests: 0,
          bandwidthBytes: 0,
          aiNeurons: 0,
        },
    domainsRes.json() as Promise<Props["domains"]>,
    secretsRes.ok ? (secretsRes.json() as Promise<Props["secrets"]>) : [],
    resourcesRes.ok ? (resourcesRes.json() as Promise<Props["resources"]>) : [],
  ]);

  const activeDomain = domains.find((d) => d.status === "active") ?? domains[0];
  return {
    project: { ...project, custom_domain: activeDomain?.hostname ?? null },
    deployments,
    usage,
    domains,
    secrets,
    resources,
  };
});

export const action = defineHandler(async (c) => {
  const id = c.req.param("id");
  const form = await c.req.parseBody();
  const intent = form._intent as string;

  if (intent === "add-domain") {
    await api(c, `/projects/${id}/domains`, {
      method: "POST",
      body: JSON.stringify({ hostname: form.hostname as string }),
    });
  } else if (intent === "remove-domain") {
    await api(c, `/projects/${id}/domains/${form.domainId as string}`, {
      method: "DELETE",
    });
  } else if (intent === "add-secret") {
    await api(c, `/projects/${id}/secrets/${form.name as string}`, {
      method: "PUT",
      body: JSON.stringify({ value: form.value as string }),
    });
  } else if (intent === "remove-secret") {
    await api(c, `/projects/${id}/secrets/${form.name as string}`, {
      method: "DELETE",
    });
  }
});
