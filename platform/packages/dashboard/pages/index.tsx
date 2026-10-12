import Stack, { VStack } from '@nkzw/stack';
import type { Props } from './index.server.ts';

export default function AuthenticatedPage({ user }: Props) {
  return (
    <main className="dashboard-main">
      <section className="wrapper wrapper--ticks dashboard-page dashboard-home">
        <VStack gap={20}>
          <VStack gap={8}>
            <h1 className="dashboard-heading">You’re signed in.</h1>
            <p className="dashboard-description">
              Authenticated as <strong className="dashboard-identity">{user.login}</strong>.
            </p>
          </VStack>
          <Stack>
            <a className="button" href="/account">
              Manage login methods
            </a>
            <a className="button" href="/logout">
              Sign out
            </a>
          </Stack>
        </VStack>
      </section>
    </main>
  );
}
