/** @jsxImportSource @voidcloud/api/admin-jsx */

import { useEffect } from 'react';
import { useRequest, useView } from 'react-fate';
import { formatPlatformPageTitle } from '../../platform-identity.ts';
import type { DeployManifest } from '../../types.ts';
import {
  DeploymentsPageView,
  DeploymentDetailView,
  BuildDetailView,
  CliVersionsView,
  SignupView,
  InvitationsView,
  AuthSettingsView,
  AuthNewView,
  AuthEditView,
  EmailSettingsView,
  EmailProjectView,
  ProjectDetailView,
  ProjectsPageView,
  UserDetailView,
  UsersPageView,
  deploymentsPageRequest,
  deploymentDetailRequest,
  buildDetailRequest,
  cliVersionsRequest,
  signupRequest,
  invitationsRequest,
  authSettingsRequest,
  authNewRequest,
  authEditRequest,
  emailSettingsRequest,
  emailProjectRequest,
  projectDetailRequest,
  projectsPageRequest,
  userDetailRequest,
  usersPageRequest,
} from '../fate/views.ts';
import { AuthEditPage } from './views/AuthEditPage.tsx';
import { AuthNewPage } from './views/AuthNewPage.tsx';
import { AuthSettingsPage } from './views/AuthSettingsPage.tsx';
import { BuildDetailPage } from './views/BuildDetailPage.tsx';
import { CliVersionsPage } from './views/CliVersionsPage.tsx';
import { DeploymentDetailPage } from './views/DeploymentDetailPage.tsx';
import { DeploymentsListPage } from './views/DeploymentsListPage.tsx';
import { EmailProjectPage } from './views/EmailProjectPage.tsx';
import { EmailSettingsPage } from './views/EmailSettingsPage.tsx';
import { InvitationsPage } from './views/InvitationsPage.tsx';
import { ProjectDetailPage } from './views/ProjectDetailPage.tsx';
import { ProjectsListPage } from './views/ProjectsListPage.tsx';
import { SignupControlPage } from './views/SignupControlPage.tsx';
import { UserDetailPage } from './views/UserDetailPage.tsx';
import { UsersListPage } from './views/UsersListPage.tsx';

type PageShellProps = Readonly<{
  path: string;
  platformName: string;
  username?: string;
}>;

function useDetailTitle(title: string, platformName: string) {
  useEffect(() => {
    document.title = formatPlatformPageTitle(title, platformName);
  }, [title, platformName]);
}

export function FateUsersPage({ path, platformName, username }: PageShellProps) {
  const { usersPage: ref } = useRequest(usersPageRequest(path), { mode: 'stale-while-revalidate' });
  const data = useView(UsersPageView, ref);
  if (!data) {
    throw new Error('Users page data is unavailable.');
  }
  return <UsersListPage {...data} platformName={platformName} username={username} />;
}

export function FateProjectsPage({ path, platformName, username }: PageShellProps) {
  const { projectsPage: ref } = useRequest(projectsPageRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const data = useView(ProjectsPageView, ref);
  if (!data) {
    throw new Error('Projects page data is unavailable.');
  }
  return <ProjectsListPage {...data} platformName={platformName} username={username} />;
}

export function FateDeploymentsPage({ path, platformName, username }: PageShellProps) {
  const { deploymentsPage: ref } = useRequest(deploymentsPageRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const data = useView(DeploymentsPageView, ref);
  if (!data) {
    throw new Error('Deployments page data is unavailable.');
  }
  return <DeploymentsListPage {...data} platformName={platformName} username={username} />;
}

export function FateUserDetailPage({ path, platformName, username }: PageShellProps) {
  const { userDetail: ref } = useRequest(userDetailRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const data = useView(UserDetailView, ref);
  if (!data) {
    throw new Error('User data is unavailable.');
  }
  useDetailTitle(data.user.login, platformName);
  return <UserDetailPage {...data} platformName={platformName} username={username} />;
}

export function FateProjectDetailPage({ path, platformName, username }: PageShellProps) {
  const { projectDetail: ref } = useRequest(projectDetailRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const data = useView(ProjectDetailView, ref);
  if (!data) {
    throw new Error('Project data is unavailable.');
  }
  useDetailTitle(data.project.slug, platformName);
  return <ProjectDetailPage {...data} platformName={platformName} username={username} />;
}

export function FateDeploymentDetailPage({ path, platformName, username }: PageShellProps) {
  const { deploymentDetail: ref } = useRequest(deploymentDetailRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const data = useView(DeploymentDetailView, ref);
  if (!data) {
    throw new Error('Deployment data is unavailable.');
  }
  useDetailTitle(`Deployment ${data.deployment.id}`, platformName);
  return (
    <DeploymentDetailPage
      {...data}
      manifest={data.manifest as DeployManifest | null}
      platformName={platformName}
      username={username}
    />
  );
}

export function FateBuildDetailPage({ path, platformName, username }: PageShellProps) {
  const { buildDetail: ref } = useRequest(buildDetailRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const data = useView(BuildDetailView, ref);
  if (!data) {
    throw new Error('Build data is unavailable.');
  }
  useDetailTitle(`Build ${data.build.id}`, platformName);
  return <BuildDetailPage {...data} platformName={platformName} username={username} />;
}

export function FateCliVersionsPage({ path, platformName, username }: PageShellProps) {
  const { cliVersions: ref } = useRequest(cliVersionsRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const data = useView(CliVersionsView, ref);
  if (!data) {
    throw new Error('CLI version data is unavailable.');
  }
  return <CliVersionsPage {...data} platformName={platformName} username={username} />;
}

export function FateSignupPage({ path, platformName, username }: PageShellProps) {
  const { signupControl: ref } = useRequest(signupRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const data = useView(SignupView, ref);
  if (!data) {
    throw new Error('Signup settings are unavailable.');
  }
  return <SignupControlPage {...data} platformName={platformName} username={username} />;
}

export function FateInvitationsPage({ path, platformName, username }: PageShellProps) {
  const { invitations: ref } = useRequest(invitationsRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const data = useView(InvitationsView, ref);
  if (!data) {
    throw new Error('Invitations are unavailable.');
  }
  return <InvitationsPage {...data} platformName={platformName} username={username} />;
}

export function FateAuthSettingsPage({ path, platformName, username }: PageShellProps) {
  const { authSettings: ref } = useRequest(authSettingsRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const data = useView(AuthSettingsView, ref);
  if (!data) {
    throw new Error('Authentication settings are unavailable.');
  }
  return <AuthSettingsPage {...data} platformName={platformName} username={username} />;
}

export function FateAuthNewPage({ path, platformName, username }: PageShellProps) {
  const { authNew: ref } = useRequest(authNewRequest(path));
  const data = useView(AuthNewView, ref);
  if (!data) {
    throw new Error('Login method is unavailable.');
  }
  return (
    <AuthNewPage {...data} id={data.connectionId} platformName={platformName} username={username} />
  );
}

export function FateAuthEditPage({ path, platformName, username }: PageShellProps) {
  const { authEdit: ref } = useRequest(authEditRequest(path), { mode: 'stale-while-revalidate' });
  const data = useView(AuthEditView, ref);
  if (!data) {
    throw new Error('Login method is unavailable.');
  }
  return <AuthEditPage {...data} platformName={platformName} username={username} />;
}

export function FateEmailSettingsPage({ path, platformName, username }: PageShellProps) {
  const { emailSettings: ref } = useRequest(emailSettingsRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const data = useView(EmailSettingsView, ref);
  if (!data) {
    throw new Error('Email settings are unavailable.');
  }
  return <EmailSettingsPage {...data} platformName={platformName} username={username} />;
}

export function FateEmailProjectPage({ path, platformName, username }: PageShellProps) {
  const { emailProject: ref } = useRequest(emailProjectRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const data = useView(EmailProjectView, ref);
  if (!data) {
    throw new Error('Project email data is unavailable.');
  }
  useDetailTitle(`Email - ${data.project.slug}`, platformName);
  return <EmailProjectPage {...data} platformName={platformName} username={username} />;
}
