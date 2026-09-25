import { AuthEditPage } from './views/auth-edit.tsx';
import { AuthErrorPage } from './views/auth-error.tsx';
import { AuthNewPage } from './views/auth-new.tsx';
import { AuthSettingsPage } from './views/auth-settings.tsx';
import { BuildDetailPage } from './views/build-detail.tsx';
import { CliVersionsPage } from './views/cli-versions.tsx';
import { DashboardPage } from './views/dashboard.tsx';
import { DeploymentDetailPage } from './views/deployment-detail.tsx';
import { DeploymentsListPage } from './views/deployments-list.tsx';
import { EmailOperationPage } from './views/email-operation.tsx';
import { EmailProjectPage } from './views/email-project.tsx';
import { EmailSettingsPage } from './views/email-settings.tsx';
import { AdminErrorPage } from './views/error.tsx';
import { InvitationsPage } from './views/invitations.tsx';
import { LoginErrorPage } from './views/login-error.tsx';
import { AdminLoginPage } from './views/login.tsx';
import { ProjectDetailPage } from './views/project-detail.tsx';
import { ProjectOwnerPreviewPage } from './views/project-owner-preview.tsx';
import { ProjectsListPage } from './views/projects-list.tsx';
import { SignupControlPage } from './views/signup-control.tsx';
import { UserDetailPage } from './views/user-detail.tsx';
import { UsersListPage } from './views/users-list.tsx';

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
