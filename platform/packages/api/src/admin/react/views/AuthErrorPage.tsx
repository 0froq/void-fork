/** @jsxImportSource @voidcloud/api/admin-jsx */
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
      <p>
        <a href="/admin/config/auth">Return to settings</a> |{' '}
        <a href="/admin/logout">Sign in again</a>
      </p>
    </Layout>
  );
}
