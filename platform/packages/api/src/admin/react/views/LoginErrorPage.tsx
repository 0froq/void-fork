/** @jsxImportSource @voidcloud/api/admin-jsx */
import { Banner } from '@astryxdesign/core/Banner';

export function LoginErrorPage({ message }: { message: string }) {
  return (
    <main className="void-admin-auth">
      <Banner status="error" title="Login failed" description={message} />
    </main>
  );
}
