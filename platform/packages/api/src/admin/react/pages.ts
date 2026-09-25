import { CliVersionsPage } from './views/cli-versions.tsx';
import { DashboardPage } from './views/dashboard.tsx';
import { DeploymentsListPage } from './views/deployments-list.tsx';
import { EmailSettingsPage } from './views/email-settings.tsx';
import { InvitationsPage } from './views/invitations.tsx';
import { ProjectsListPage } from './views/projects-list.tsx';
import { SignupControlPage } from './views/signup-control.tsx';
import { UserDetailPage } from './views/user-detail.tsx';
import { UsersListPage } from './views/users-list.tsx';

export const adminComponents = {
  dashboard: async () => ({ default: DashboardPage }),
  users: async () => ({ default: UsersListPage }),
  userDetail: async () => ({ default: UserDetailPage }),
  projects: async () => ({ default: ProjectsListPage }),
  deployments: async () => ({ default: DeploymentsListPage }),
  cliVersions: async () => ({ default: CliVersionsPage }),
  signupControl: async () => ({ default: SignupControlPage }),
  email: async () => ({ default: EmailSettingsPage }),
  invitations: async () => ({ default: InvitationsPage }),
};

export type AdminPageId = keyof typeof adminComponents;

export function matchAdminRoute(url: string): AdminPageId | null {
  const path = new URL(url, 'https://void.invalid').pathname;
  if (path === '/admin/') {
    return 'dashboard';
  }
  if (path === '/admin/users') {
    return 'users';
  }
  if (/^\/admin\/users\/[^/]+$/.test(path)) {
    return 'userDetail';
  }
  if (path === '/admin/projects') {
    return 'projects';
  }
  if (path === '/admin/deployments') {
    return 'deployments';
  }
  if (path === '/admin/cli-versions') {
    return 'cliVersions';
  }
  if (path === '/admin/signup-control') {
    return 'signupControl';
  }
  if (path === '/admin/email') {
    return 'email';
  }
  if (path === '/admin/invitations') {
    return 'invitations';
  }
  return null;
}
