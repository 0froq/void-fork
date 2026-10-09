/** @jsxImportSource @voidcloud/api/admin-jsx */
import { Button } from '@astryxdesign/core/Button';
import { Layout } from './Layout.tsx';

export function AuthErrorPage({
  message,
  platformName,
  username,
}: {
  message: string;
  platformName: string;
  username?: string;
}) {
  return (
    <Layout platformName={platformName} title="Authentication settings" username={username}>
      <h1>Authentication settings</h1>
      <p>{message}</p>
      <Button as="a" href="/admin/logout" label="Sign in again" />
    </Layout>
  );
}
