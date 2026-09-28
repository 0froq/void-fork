/** @jsxImportSource @voidcloud/api/admin-jsx */
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';

export function AdminErrorPage({ message, status }: { message: string; status: number }) {
  return (
    <main className="void-admin-auth">
      <Banner status="error" title={message} />
      <div className="void-admin-auth-actions">
        <Button
          as="a"
          href={status === 401 ? '/admin/logout' : '/admin/'}
          label={status === 401 ? 'Sign in again' : 'Return to admin'}
        />
      </div>
    </main>
  );
}
