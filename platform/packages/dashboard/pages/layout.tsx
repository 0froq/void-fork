import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { useNavigation, useShared } from '@void/react';
import { LogOut } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import preventDragging from '../lib/preventDragging.ts';
import type { DashboardShared } from '../middleware/01.auth.ts';
import blueskyIcon from '../ui/assets/icons/bluesky.svg';
import discordIcon from '../ui/assets/icons/discord.svg';
import githubIcon from '../ui/assets/icons/github.svg';
import xIcon from '../ui/assets/icons/x.svg';
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
    { icon: githubIcon, label: 'GitHub', link: 'https://github.com/voidzero-dev' },
    { icon: blueskyIcon, label: 'Bluesky', link: 'https://bsky.app/profile/voidzero.dev' },
    { icon: discordIcon, label: 'Discord', link: 'https://discord.gg/cC6TEVFKSx' },
    { icon: xIcon, label: 'X.com', link: 'https://x.com/voidzerodev' },
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
            accountMenuItems={[
              {
                icon: <LogOut aria-hidden="true" className="dashboard-account-icon" />,
                link: '/logout',
                text: 'Logout',
              },
            ]}
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
