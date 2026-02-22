import { defineHandler } from "vite-cloud";
import { api, ApiError } from "../../lib/api";

interface Project {
  id: string;
  slug: string;
  mode: string;
  custom_domain: string | null;
  created_at: string;
}

interface Deployment {
  id: string;
  status: "pending" | "uploading" | "migrating" | "prerendering" | "live" | "failed";
  source: string | null;
  commit: string | null;
  error_message: string | null;
  created_at: string;
  deployed_at: string | null;
}

interface Usage {
  projectId: string;
  billingPeriodStart: string;
  requests: number;
  bandwidthBytes: number;
  aiNeurons: number;
}

interface Domain {
  id: string;
  hostname: string;
  status: "pending" | "active";
  created_at: string;
}

interface Secret {
  name: string;
}

interface Resource {
  id: string;
  type: "d1" | "kv" | "r2" | "queue";
  binding_name: string;
}

export interface Props {
  project: Project;
  deployments: Deployment[];
  usage: Usage;
  domains: Domain[];
  secrets: Secret[];
  resources: Resource[];
}

export const loader = defineHandler<Props>(async (c) => {
  const id = c.req.param("id");

  let project: Project;
  try {
    project = await api<Project>(c, `/projects/${id}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      return c.notFound();
    }
    throw e;
  }

  const [deployments, usage, domains, secrets, resources] = await Promise.all([
    api<Deployment[]>(c, `/projects/${id}/deployments`),
    api<Usage>(c, `/projects/${id}/usage`).catch(() => ({
      projectId: id,
      billingPeriodStart: new Date().toISOString(),
      requests: 0,
      bandwidthBytes: 0,
      aiNeurons: 0,
    })),
    api<Domain[]>(c, `/projects/${id}/domains`),
    api<Secret[]>(c, `/projects/${id}/secrets`).catch(() => []),
    api<Resource[]>(c, `/projects/${id}/resources`).catch(() => []),
  ]);

  return { project, deployments, usage, domains, secrets, resources };
});

export const action = defineHandler(async (c) => {
  const id = c.req.param("id");
  const form = await c.req.parseBody();
  const intent = form._intent as string;

  if (intent === "add-domain") {
    await api(c, `/projects/${id}/domains`, {
      method: "POST",
      body: JSON.stringify({ hostname: form.hostname }),
    });
  } else if (intent === "remove-domain") {
    await api(c, `/projects/${id}/domains/${form.domainId}`, {
      method: "DELETE",
    });
  } else if (intent === "add-secret") {
    await api(c, `/projects/${id}/secrets/${form.name}`, {
      method: "PUT",
      body: JSON.stringify({ value: form.value }),
    });
  } else if (intent === "remove-secret") {
    await api(c, `/projects/${id}/secrets/${form.name}`, {
      method: "DELETE",
    });
  }
});
