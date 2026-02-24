import { defineHandler } from "void";
import {
  getProject,
  getProjectDeployments,
  getDomainsByProjectId,
  getProjectResources,
} from "@voidcloud/api/db";
import type { Project, Deployment, Domain, Resource } from "@voidcloud/api/types";
import { createClient, api, type API, type Client } from "../../lib/api";

type P = Client["projects"][":id"];

export type Props = {
  project: Project & { custom_domain: string | null };
  deployments: Deployment[];
  usage: API<"usage", P>;
  domains: Domain[];
  secrets: API<"secrets", P>;
  resources: Resource[];
};

export const loader = defineHandler<Props>(async (c) => {
  const id = c.req.param("id");
  const db = c.get("db");

  // Direct D1
  const project = await getProject(db, id);
  if (!project) return c.notFound();

  const [deployments, domains, resources] = await Promise.all([
    getProjectDeployments(db, project.id),
    getDomainsByProjectId(db, project.id),
    getProjectResources(db, project.id),
  ]);

  // Still via API (Analytics Engine + CF API)
  const client = createClient(c);
  const [usageRes, secretsRes] = await Promise.all([
    client.projects[":id"].usage.$get({ param: { id } }),
    client.projects[":id"].secrets.$get({ param: { id } }),
  ]);
  const usage = usageRes.ok
    ? ((await usageRes.json()) as Props["usage"])
    : {
        projectId: id,
        billingPeriodStart: new Date().toISOString(),
        requests: 0,
        bandwidthBytes: 0,
        aiNeurons: 0,
      };
  const secrets = secretsRes.ok ? ((await secretsRes.json()) as Props["secrets"]) : [];

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
