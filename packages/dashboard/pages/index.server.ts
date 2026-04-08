import { getProjectsByUserId, getDomainsByProjectId } from '@voidcloud/api/db';
import type { Project } from '@voidcloud/api/types';
import { defineHandler } from 'void';
import { createClient, type API } from '../lib/api';

export type Props = {
  projects: (Project & { custom_domain: string | null })[];
  usage: API<'usage'>;
  siteDomain: string;
};

export const loader = defineHandler<Props>(async (c) => {
  const db = c.get('db');
  const userId = c.get('userId');
  const client = createClient(c);

  // Start usage request immediately to avoid serializing external API latency after D1 queries.
  const usagePromise = client.usage.$get();

  // Direct D1
  const projectsWithDomainsPromise = getProjectsByUserId(db, userId).then((projects) =>
    Promise.all(
      projects.map(async (p) => {
        const domains = await getDomainsByProjectId(db, p.id);
        const domain = domains.find((d) => d.status === 'active') ?? domains[0];
        return { ...p, custom_domain: domain?.hostname ?? null };
      }),
    ),
  );

  // Still via API (Analytics Engine)
  const [projectsWithDomains, usageRes] = await Promise.all([
    projectsWithDomainsPromise,
    usagePromise,
  ]);
  const usage = usageRes.ok
    ? await usageRes.json()
    : { requests: 0, bandwidthBytes: 0, aiNeurons: 0, projects: [] };

  const siteDomain = (c.env as Record<string, string>).SITE_DOMAIN ?? 'void.app';
  return { projects: projectsWithDomains, usage, siteDomain };
});
