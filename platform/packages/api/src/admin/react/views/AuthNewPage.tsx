/** @jsxImportSource @voidcloud/api/admin-jsx */

import { useRequest, useView } from 'react-fate';
import { AuthNewView, authNewRequest } from '../../fate/views.ts';
import { type AdminPageProps } from '../page-utils.ts';
import { ConnectionForm } from './ConnectionForm.tsx';
import { Layout } from './Layout.tsx';
export function AuthNewPage({ path, platformName, username }: AdminPageProps) {
  const { authNew: ref } = useRequest(authNewRequest(path));
  const pageData = useView(AuthNewView, ref);
  if (!pageData) {
    throw new Error('Login method is unavailable.');
  }
  const { kind, connectionId: id, callbackUrl } = pageData;
  return (
    <Layout platformName={platformName} title="Add login method" username={username}>
      <h1>Add login method</h1>
      <ConnectionForm
        configuration={{
          id,
          kind,
          label:
            kind === 'oidc'
              ? 'Company SSO'
              : kind === 'cloudflare-access'
                ? 'Cloudflare Access'
                : kind === 'github'
                  ? 'GitHub'
                  : 'Google',
        }}
        revision={null}
        callbackUrl={callbackUrl}
      />
    </Layout>
  );
}
