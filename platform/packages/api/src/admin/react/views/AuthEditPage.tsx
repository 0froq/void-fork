/** @jsxImportSource @voidcloud/api/admin-jsx */
import type { PlatformLoginConfiguration } from '@void/platform';
import { ConnectionForm } from './ConnectionForm.tsx';
import { Layout } from './Layout.tsx';
export function AuthEditPage({
  configuration,
  revision,
  callbackUrl,
  platformName,
  username,
  label,
}: {
  configuration: PlatformLoginConfiguration;
  revision: number;
  callbackUrl: string;
  platformName: string;
  username?: string;
  label: string;
}) {
  return (
    <Layout platformName={platformName} title="Edit login method" username={username}>
      <h1>Edit {label}</h1>
      <ConnectionForm configuration={configuration} revision={revision} callbackUrl={callbackUrl} />
    </Layout>
  );
}
