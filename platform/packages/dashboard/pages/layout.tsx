import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { useNavigation, useShared } from '@void/react';
import { useEffect, type ReactNode } from 'react';
import preventDragging from '../lib/preventDragging.ts';
import type { DashboardShared } from '../middleware/01.auth.ts';
import { AppHeader, FooterNav } from '../ui/index.ts';
import '../app.css';

const footerConfig = {
  nav: [
    {
      items: [
        { link: 'https://void.cloud/', text: 'Void Cloud' },
        { link: 'https://voidzero.dev/', text: 'VoidZero' },
      ],
      title: 'COMPANY',
    },
    {
      items: [
        { link: 'https://github.com/voidzero-dev', text: 'GitHub' },
        { link: 'https://discord.gg/cC6TEVFKSx', text: 'Discord' },
      ],
      title: 'Community',
    },
  ],
  social: [
    { icon: 'github', link: 'https://github.com/voidzero-dev' },
    { icon: 'bluesky', link: 'https://bsky.app/profile/voidzero.dev' },
    { icon: 'discord', link: 'https://discord.gg/cC6TEVFKSx' },
    { icon: 'x', link: 'https://x.com/voidzerodev' },
  ],
};

function FlexibleFooterSpacer() {
  return <div aria-hidden="true" className="wrapper dashboard-footer-spacer" />;
}

export default function Layout({ children }: { children: ReactNode }) {
  const { user } = useShared<DashboardShared>();
  const navigation = useNavigation();
  const isLoading = navigation.state !== 'idle';

  useEffect(() => preventDragging(), []);

  if (!user) {
    return (
      <>
        {isLoading && <div className="nav-progress loading" />}
        {children}
      </>
    );
  }

  return (
    <>
      {isLoading && <div className="nav-progress loading" />}
      <Theme theme={neutralTheme}>
        <div className="dashboard-layout">
          <AppHeader
            accountMenuLabel={user.login}
            accountMenuItems={[{ icon: 'lucide:log-out', link: '/logout', text: 'Logout' }]}
          />
          <div className="dashboard-content">
            {children}
            <FlexibleFooterSpacer />
          </div>
          <FooterNav footer={footerConfig} />
        </div>
      </Theme>
    </>
  );
}
