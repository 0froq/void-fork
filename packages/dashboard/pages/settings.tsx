import { HeadingSection, Spacer } from '@voidcloud/ui';
import type { Props } from './settings.server.ts';

export default function SettingsPage({ user }: Props) {
  return (
    <main className="bg-white dark:bg-primary">
      <HeadingSection
        heading="Settings"
        subheading="Profile information for the account currently signed in to the dashboard."
      />

      <section className="wrapper wrapper--ticks border-t bg-white dark:bg-primary">
        <Row label="Login" value={user.login} />
        <Row label="Email" value={user.email ?? '-'} />
        <Row label="Provider" value={user.provider} />
        <Row label="Role" value={user.role} />
      </section>
      <Spacer />
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-stroke p-4 last:border-b-0 dark:border-nickel">
      <span className="text-sm text-grey">{label}</span>
      <span className="text-xs text-primary dark:text-white">{value}</span>
    </div>
  );
}
