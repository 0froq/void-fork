import { defineHandler } from 'void';
import { createClient, type API } from '../lib/api.ts';

export type Props =
  | {
      canAccessDashboard: false;
      user: API<'me'>;
    }
  | {
      canAccessDashboard: true;
      user: API<'me'>;
      projects: API<'projects'>;
      siteDomain: string;
    };

export const loader = defineHandler<Props>(async (c) => {
  const user = c.get('dashboardUser');
  if (!c.get('canAccessDashboard')) {
    return { canAccessDashboard: false, user };
  }

  const client = createClient(c);
  const projectsRes = await client.projects.$get();
  const projects = projectsRes.ok ? await projectsRes.json() : [];
  const siteDomain = (c.env as Record<string, string>).SITE_DOMAIN ?? 'void.app';

  return {
    canAccessDashboard: true,
    user,
    projects,
    siteDomain,
  };
});
