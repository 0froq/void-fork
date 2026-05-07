import { useNavigation, useShared } from '@void/react';
import { AppHeader, FooterNav, ThemeContextProvider } from '@voidcloud/ui';
import monoIcon from '@voidcloud/ui/assets/icons/void-icon.svg';
import logoDark from '@voidcloud/ui/assets/logos/void-dark.svg';
import logoLight from '@voidcloud/ui/assets/logos/void-light.svg';
import footerBg from '@voidcloud/ui/assets/vite/footer-background.jpg';
import type { ReactNode } from 'react';
import type { DashboardShared } from '../middleware/01.auth.ts';
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

export default function Layout({ children }: { children: ReactNode }) {
  const { user, canAccessDashboard } = useShared<DashboardShared>();
  const navigation = useNavigation();
  const isLoading = navigation.state !== 'idle';

  if (!user || !canAccessDashboard) {
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
      <ThemeContextProvider
        value={{
          footerBg,
          logoAlt: 'Void',
          logoDark,
          logoLight,
          monoIcon,
        }}
      >
        <div className="marketing-layout min-h-screen bg-white text-primary dark:bg-primary dark:text-white">
          <AppHeader
            accountMenuLabel={user.login}
            accountMenuItems={[
              { icon: 'lucide:settings', link: '/settings', text: 'Settings' },
              { icon: 'lucide:log-out', link: '/logout', text: 'Logout' },
            ]}
          />
          {children}
          <FooterNav footer={footerConfig} />
        </div>
      </ThemeContextProvider>
    </>
  );
}
