import { AdminErrorPage } from './views/AdminErrorPage.tsx';
import { AdminLoginPage } from './views/AdminLoginPage.tsx';
import { AuthEditPage } from './views/AuthEditPage.tsx';
import { AuthErrorPage } from './views/AuthErrorPage.tsx';
import { AuthNewPage } from './views/AuthNewPage.tsx';
import { AuthSettingsPage } from './views/AuthSettingsPage.tsx';
import { BuildDetailPage } from './views/BuildDetailPage.tsx';
import { CliVersionsPage } from './views/CliVersionsPage.tsx';
import { DashboardPage } from './views/DashboardPage.tsx';
import { DeploymentDetailPage } from './views/DeploymentDetailPage.tsx';
import { DeploymentsListPage } from './views/DeploymentsListPage.tsx';
import { EmailOperationPage } from './views/EmailOperationPage.tsx';
import { EmailProjectPage } from './views/EmailProjectPage.tsx';
import { EmailSettingsPage } from './views/EmailSettingsPage.tsx';
import { InvitationsPage } from './views/InvitationsPage.tsx';
import { LoginErrorPage } from './views/LoginErrorPage.tsx';
import { ProjectDetailPage } from './views/ProjectDetailPage.tsx';
import { ProjectOwnerPreviewPage } from './views/ProjectOwnerPreviewPage.tsx';
import { ProjectsListPage } from './views/ProjectsListPage.tsx';
import { SignupControlPage } from './views/SignupControlPage.tsx';
import { UserDetailPage } from './views/UserDetailPage.tsx';
import { UsersListPage } from './views/UsersListPage.tsx';

export const adminComponents = {
  dashboard: async () => ({ default: DashboardPage }),
  adminLogin: async () => ({ default: AdminLoginPage }),
  loginError: async () => ({ default: LoginErrorPage }),
  authSettings: async () => ({ default: AuthSettingsPage }),
  authNew: async () => ({ default: AuthNewPage }),
  authEdit: async () => ({ default: AuthEditPage }),
  authError: async () => ({ default: AuthErrorPage }),
  buildDetail: async () => ({ default: BuildDetailPage }),
  deploymentDetail: async () => ({ default: DeploymentDetailPage }),
  users: async () => ({ default: UsersListPage }),
  userDetail: async () => ({ default: UserDetailPage }),
  projects: async () => ({ default: ProjectsListPage }),
  projectDetail: async () => ({ default: ProjectDetailPage }),
  projectOwnerPreview: async () => ({ default: ProjectOwnerPreviewPage }),
  deployments: async () => ({ default: DeploymentsListPage }),
  cliVersions: async () => ({ default: CliVersionsPage }),
  signupControl: async () => ({ default: SignupControlPage }),
  email: async () => ({ default: EmailSettingsPage }),
  emailProject: async () => ({ default: EmailProjectPage }),
  emailOperation: async () => ({ default: EmailOperationPage }),
  adminError: async () => ({ default: AdminErrorPage }),
  invitations: async () => ({ default: InvitationsPage }),
};

export type AdminPageId = keyof typeof adminComponents;

export function matchAdminRoute(url: string): AdminPageId | null {
  const path = new URL(url, 'https://void.invalid').pathname;
  if (path === '/admin/') {
    return 'dashboard';
  }
  if (path === '/admin/login') {
    return 'adminLogin';
  }
  if (path === '/admin/users') {
    return 'users';
  }
  if (/^\/admin\/builds\/[^/]+$/.test(path)) {
    return 'buildDetail';
  }
  if (/^\/admin\/users\/[^/]+$/.test(path)) {
    return 'userDetail';
  }
  if (path === '/admin/projects') {
    return 'projects';
  }
  if (/^\/admin\/projects\/[^/]+$/.test(path)) {
    return 'projectDetail';
  }
  if (/^\/admin\/projects\/[^/]+\/owner\/preview$/.test(path)) {
    return 'projectOwnerPreview';
  }
  if (path === '/admin/deployments') {
    return 'deployments';
  }
  if (/^\/admin\/deployments\/[^/]+$/.test(path)) {
    return 'deploymentDetail';
  }
  if (path === '/admin/cli-versions') {
    return 'cliVersions';
  }
  if (path === '/admin/signup-control') {
    return 'signupControl';
  }
  if (path === '/admin/config/auth') {
    return 'authSettings';
  }
  if (path === '/admin/config/auth/new') {
    return 'authNew';
  }
  if (/^\/admin\/config\/auth\/connections\/[^/]+$/.test(path)) {
    return 'authEdit';
  }
  if (path === '/admin/email') {
    return 'email';
  }
  if (/^\/admin\/email\/[^/]+$/.test(path)) {
    return 'emailProject';
  }
  if (path === '/admin/invitations') {
    return 'invitations';
  }
  return null;
}
