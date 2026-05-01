import { AppHeader, FooterNav, ThemeContextProvider } from '@voidcloud/ui';
import heroBackground from '@voidcloud/ui/assets/hero-background.jpg';
import monoIcon from '@voidcloud/ui/assets/icons/void-icon.svg';
import logoDark from '@voidcloud/ui/assets/logos/void-dark.svg';
import logoLight from '@voidcloud/ui/assets/logos/void-light.svg';
import footerBg from '@voidcloud/ui/assets/vite/footer-background.jpg';
import type { ReactNode } from 'react';
import type { Props } from './login.server.ts';

function FlexibleSpacer() {
  return (
    <section
      aria-hidden="true"
      className="wrapper wrapper--ticks min-h-12 w-full flex-1 border-t"
    />
  );
}

const footerConfig = {
  nav: [
    {
      items: [
        { link: 'https://void.cloud/', text: 'Void Cloud' },
        { link: 'https://voidzero.dev/', text: 'VoidZero' },
      ],
      title: 'COMPANY',
    },
  ],
  social: [
    { icon: 'github', link: 'https://github.com/voidzero-dev' },
    { icon: 'bluesky', link: 'https://bsky.app/profile/voidzero.dev' },
    { icon: 'discord', link: 'https://discord.gg/cC6TEVFKSx' },
    { icon: 'x', link: 'https://x.com/voidzerodev' },
  ],
};

function LoginPageShell({ children }: { children: ReactNode }) {
  return (
    <ThemeContextProvider
      value={{
        footerBg,
        logoAlt: 'Void',
        logoDark,
        logoLight,
        monoIcon,
      }}
    >
      <div className="login-public-shell marketing-layout min-h-screen bg-white text-primary dark:bg-primary dark:text-white">
        <AppHeader />
        <main className="login-public-main flex min-h-[calc(100vh-206px)] flex-col">
          <section className="login-public-hero wrapper wrapper--ticks grid w-full divide-x divide-stroke border-t border-stroke md:grid-cols-2 dark:divide-nickel dark:border-nickel">
            <div className="login-public-copy flex flex-col items-center justify-center p-5 md:items-start">
              <div className="login-public-copy-inner flex max-w-[30rem] flex-col items-center gap-5 text-center md:items-start md:text-left">
                {children}
              </div>
            </div>
            <div className="login-public-art-column flex min-h-[9rem] flex-col sm:min-h-[18rem]">
              <div
                className="login-public-art relative flex h-full flex-col justify-center overflow-clip bg-cover bg-center py-8 pl-6 sm:py-16 sm:pl-16"
                style={{ backgroundImage: `url(${heroBackground})` }}
              />
            </div>
          </section>
          <FlexibleSpacer />
        </main>
        <FooterNav footer={footerConfig} />
      </div>
    </ThemeContextProvider>
  );
}

export default function LoginPage({ githubUrl, googleUrl }: Props) {
  return (
    <LoginPageShell>
      <h1 className="max-w-[25rem] text-pretty">Sign in to your dashboard.</h1>
      <div className="mt-8 flex flex-col items-center gap-5 sm:flex-row">
        <a className="button button--primary text-white! hover:text-white!" href={githubUrl}>
          <span className="text-white">Continue with GitHub</span>
        </a>
        <a className="button" href={googleUrl}>
          Continue with Google
        </a>
      </div>
    </LoginPageShell>
  );
}
