/** @jsxImportSource @voidcloud/api/admin-jsx */

import { LinkProvider } from '@astryxdesign/core/Link';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { Link } from '@void/react';
import { useShared } from '@void/react';
import { useMemo, type ReactNode } from 'react';
import { FateClient } from 'react-fate';
import { createFateClient } from '../fate/client.generated.ts';
import { AdminFateErrorBoundary } from './AdminFateErrorBoundary.tsx';

type AdminShared = {
  adminFateSession?: string;
  adminFateSnapshot?: Parameters<ReturnType<typeof createFateClient>['hydrate']>[0];
  adminPageUrl?: string;
};

export function AdminProviders({ children }: { children: ReactNode }) {
  const shared = useShared<AdminShared>();
  const session = shared.adminFateSession ?? 'guest';
  const fate = useMemo(() => {
    const client = createFateClient({
      url: typeof window === 'undefined' ? 'http://localhost/admin/fate' : '/admin/fate',
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          credentials: 'same-origin',
        }).then((response) => {
          if (response.redirected && new URL(response.url).pathname === '/admin/login') {
            window.location.assign('/admin/login');
            throw new Error('Administrator session expired.');
          }
          return response;
        }),
    });
    if (shared.adminFateSnapshot) {
      client.hydrate(shared.adminFateSnapshot);
    }
    return client;
    // The snapshot bootstraps SSR once; a client survives navigations until the session changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);
  return (
    <Theme theme={neutralTheme}>
      <FateClient client={fate} key={session}>
        <LinkProvider component={Link}>
          <AdminFateErrorBoundary key={shared.adminPageUrl}>{children}</AdminFateErrorBoundary>
        </LinkProvider>
      </FateClient>
    </Theme>
  );
}
