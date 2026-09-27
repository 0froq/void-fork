/** @jsxImportSource @voidcloud/api/admin-jsx */
import type { PlatformLoginConfiguration } from '@void/platform';
import { ConnectionForm } from './ConnectionForm.tsx';
import { Layout } from './Layout.tsx';
export function AuthNewPage({
  kind,
  id,
  callbackUrl,
  platformName,
  username,
}: {
  kind: PlatformLoginConfiguration['kind'];
  id: string;
  callbackUrl: string;
  platformName: string;
  username?: string;
}) {
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
