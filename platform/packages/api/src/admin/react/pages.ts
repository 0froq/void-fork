import { AdminProviders } from './AdminProviders.tsx';
import {
  FateBuildDetailPage,
  FateAuthSettingsPage,
  FateAuthNewPage,
  FateAuthEditPage,
  FateEmailSettingsPage,
  FateEmailProjectPage,
  FateCliVersionsPage,
  FateDeploymentDetailPage,
  FateDeploymentsPage,
  FateProjectDetailPage,
  FateProjectsPage,
  FateSignupPage,
  FateUserDetailPage,
  FateUsersPage,
  FateInvitationsPage,
} from './FatePages.tsx';
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
  adminLayout: async () => ({ default: AdminProviders }),
  dashboard: async () => ({ default: DashboardPage }),
  adminLogin: async () => ({ default: AdminLoginPage }),
  loginError: async () => ({ default: LoginErrorPage }),
  authSettings: async () => ({ default: FateAuthSettingsPage }),
  authNew: async () => ({ default: FateAuthNewPage }),
  authEdit: async () => ({ default: FateAuthEditPage }),
  authError: async () => ({ default: AuthErrorPage }),
  buildDetail: async () => ({ default: FateBuildDetailPage }),
  deploymentDetail: async () => ({ default: FateDeploymentDetailPage }),
  users: async () => ({ default: FateUsersPage }),
  userDetail: async () => ({ default: FateUserDetailPage }),
  projects: async () => ({ default: FateProjectsPage }),
  projectDetail: async () => ({ default: FateProjectDetailPage }),
  projectOwnerPreview: async () => ({ default: ProjectOwnerPreviewPage }),
  deployments: async () => ({ default: FateDeploymentsPage }),
  cliVersions: async () => ({ default: FateCliVersionsPage }),
  signupControl: async () => ({ default: FateSignupPage }),
  email: async () => ({ default: FateEmailSettingsPage }),
  emailProject: async () => ({ default: FateEmailProjectPage }),
  emailOperation: async () => ({ default: EmailOperationPage }),
  adminError: async () => ({ default: AdminErrorPage }),
  invitations: async () => ({ default: FateInvitationsPage }),
};

export type AdminPageId = Exclude<keyof typeof adminComponents, 'adminLayout'>;

export const adminLayoutTree: Record<AdminPageId, Array<string>> = Object.fromEntries(
  Object.keys(adminComponents)
    .filter((name) => name !== 'adminLayout')
    .map((name) => [name, ['adminLayout']]),
) as Record<AdminPageId, Array<string>>;

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
