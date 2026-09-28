/** @jsxImportSource @voidcloud/api/admin-jsx */

import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Heading, Text } from '@astryxdesign/core/Text';
import { useNavigation } from '@void/react';
import type { PageObject } from 'void/pages-protocol';
import { AdminProviders } from './AdminProviders.tsx';
import { matchAdminRoute, type AdminPageId } from './pages.ts';
import { Layout } from './views/Layout.tsx';

const TITLES: Partial<Record<AdminPageId, string>> = {
  dashboard: 'Dashboard',
  users: 'Users',
  userDetail: 'User',
  projects: 'Projects',
  projectDetail: 'Project',
  projectOwnerPreview: 'Transfer owner',
  deployments: 'Deployments',
  deploymentDetail: 'Deployment',
  buildDetail: 'Build',
  cliVersions: 'CLI Versions',
  signupControl: 'Signup',
  authSettings: 'Authentication',
  authNew: 'Add login method',
  authEdit: 'Edit login method',
  email: 'Email',
  emailProject: 'Project email',
  emailOperation: 'Email operation',
  invitations: 'Invitations',
};

export function AdminNavigationFallback({ initialPageData }: { initialPageData: PageObject }) {
  const navigation = useNavigation();
  const path = navigation.location?.pathname ?? initialPageData.url;
  const title = TITLES[matchAdminRoute(path) ?? 'adminError'] ?? 'Admin';
  const platformName = String(initialPageData.props.platformName ?? 'Void');
  const username =
    typeof initialPageData.props.username === 'string' ? initialPageData.props.username : undefined;

  return (
    <AdminProviders>
      <Layout title={title} platformName={platformName} username={username}>
        <div className="void-admin-loading" role="status" aria-live="polite">
          <Heading level={1}>{title}</Heading>
          <Text type="supporting">Loading {title.toLowerCase()}…</Text>
          <div className="void-admin-loading-lines" aria-hidden="true">
            <Skeleton width="32%" height={24} />
            <Skeleton width="100%" height={48} index={1} />
            <Skeleton width="100%" height={48} index={2} />
            <Skeleton width="78%" height={48} index={3} />
          </div>
        </div>
      </Layout>
    </AdminProviders>
  );
}
