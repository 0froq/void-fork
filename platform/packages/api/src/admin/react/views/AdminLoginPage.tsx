/** @jsxImportSource @voidcloud/api/admin-jsx */
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Heading, Text } from '@astryxdesign/core/Text';

export function AdminLoginPage({ providers }: { providers: Array<{ id: string; label: string }> }) {
  return (
    <main className="void-admin-auth">
      <Card>
        <Heading level={1}>Void Admin</Heading>
        <Text>Sign in with your admin account</Text>
        <div className="void-admin-auth-actions">
          {providers.map(({ id, label }) => (
            <Button
              key={id}
              as="a"
              href={`/admin/login/${encodeURIComponent(id)}`}
              label={`Sign in with ${label}`}
            />
          ))}
        </div>
      </Card>
    </main>
  );
}
