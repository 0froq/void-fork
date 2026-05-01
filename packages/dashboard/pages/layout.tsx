import { useNavigation, useShared } from '@void/react';
import { AppHeader, FooterNav, ThemeContextProvider } from '@voidcloud/ui';
import monoIcon from '@voidcloud/ui/assets/icons/void-icon.svg';
import logoDark from '@voidcloud/ui/assets/logos/void-dark.svg';
import logoLight from '@voidcloud/ui/assets/logos/void-light.svg';
import footerBg from '@voidcloud/ui/assets/vite/footer-background.jpg';
import apkProtocolMedium from '@voidcloud/ui/fonts/APK-Protocol-Medium.woff2';
import interRomanLatin from '@voidcloud/ui/fonts/inter-roman-latin.woff2';
import khTekaMonoRegular from '@voidcloud/ui/fonts/KHTekaMono-Regular.woff2';
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

const criticalCss = `
@font-face {
  font-family: 'APK Protocol';
  font-weight: 500;
  font-display: swap;
  src: url('${apkProtocolMedium}') format('woff2');
}
@font-face {
  font-family: Inter;
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url('${interRomanLatin}') format('woff2');
  unicode-range: U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;
}
@font-face {
  font-family: 'KH Teka Mono';
  font-weight: 400;
  font-display: swap;
  src: url('${khTekaMonoRegular}') format('woff2');
}
:root {
  --font-heading: 'APK Protocol', sans-serif;
  --font-sans: Inter, sans-serif;
  --font-mono: 'KH Teka Mono', monospace;
  --color-primary: #16171d;
  --color-white: #ffffff;
  --color-beige: #f4f3ec;
  --color-nickel: #3b3440;
  --color-grey: #827a89;
  --color-stroke: #e5e4e7;
  --color-vite: #b39aff;
  --color-electric: #6c3bff;
  --color-brand: var(--color-electric);
  --color-bg: var(--color-white);
  --color-text-1: var(--color-primary);
  --color-text-2: var(--color-grey);
  --color-text-3: var(--color-stroke);
  --color-border: var(--color-stroke);
}
* { box-sizing: border-box; }
html {
  font-size: 16px;
  line-height: 1.4;
  overflow-x: clip;
  -webkit-text-size-adjust: 100%;
}
body {
  margin: 0;
  min-width: 320px;
  min-height: 100vh;
  overflow-x: clip;
  background: var(--color-bg);
  color: var(--color-text-1);
  font-family: var(--font-sans);
  font-synthesis: style;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3, h4, h5, h6 {
  margin: 0;
  font-family: var(--font-heading);
  font-weight: 500;
  line-height: 1.2;
  overflow-wrap: break-word;
}
p { margin: 0; }
ol, ul {
  margin: 0;
  padding: 0;
  list-style: none;
}
img, svg {
  display: block;
}
img {
  max-width: 100%;
  height: auto;
}
@media (prefers-color-scheme: dark) {
  :root {
    --color-bg: var(--color-primary);
    --color-text-1: var(--color-white);
    --color-brand: var(--color-vite);
    --color-border: var(--color-nickel);
  }
}
a { color: inherit; text-decoration: inherit; }
button, input { font: inherit; color: inherit; background: transparent; border-radius: 0; }
.login-public-shell {
  min-height: 100vh;
  background: var(--color-bg);
  color: var(--color-text-1);
}
.login-public-shell .hidden {
  display: none;
}
.login-public-shell .block {
  display: block;
}
@media (prefers-color-scheme: dark) {
  .login-public-shell .dark\\:hidden {
    display: none;
  }
  .login-public-shell .dark\\:block {
    display: block;
  }
}
.login-public-shell .wrapper {
  position: relative;
  max-width: calc(100vw - 2rem);
  margin-inline: auto;
  overflow-x: clip;
  border-left: 1px solid var(--color-border);
  border-right: 1px solid var(--color-border);
}
@media (min-width: 90rem) {
  .login-public-shell .wrapper {
    max-width: 90rem;
  }
}
.login-public-shell .wrapper--ticks::before,
.login-public-shell .wrapper--ticks::after {
  content: "";
  position: absolute;
  top: -5px;
  width: 0;
  height: 0;
  border-top: 5px solid transparent;
  border-bottom: 5px solid transparent;
}
.login-public-shell .wrapper--ticks::before {
  left: 0;
  border-right: 5px solid transparent;
  border-left: 5px solid var(--color-border);
}
.login-public-shell .wrapper--ticks::after {
  right: 0;
  border-right: 5px solid var(--color-border);
  border-left: 5px solid transparent;
}
.login-public-shell > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.75rem 1.5rem;
}
.login-public-shell > header > div:first-child {
  position: relative;
  display: flex;
  height: 2.75rem;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0.5rem;
}
.login-public-shell > header a {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.login-public-shell > header a > div {
  position: relative;
  margin-left: -1.5rem;
  display: flex;
  width: 1.5rem;
  height: 1.5rem;
  align-items: center;
  justify-content: center;
}
.login-public-shell > header img {
  width: auto;
  height: 1rem;
}
.login-public-shell > header > div:last-child {
  width: 2.75rem;
  height: 2.75rem;
}
.login-public-main {
  display: flex;
  min-height: calc(100vh - 206px);
  flex-direction: column;
}
.login-public-hero {
  display: grid;
  width: 100%;
  border-top: 1px solid var(--color-border);
  border-color: var(--color-border);
}
.login-public-copy {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 1.25rem;
}
.login-public-copy-inner {
  display: flex;
  max-width: 30rem;
  flex-direction: column;
  align-items: center;
  gap: 1.25rem;
  text-align: center;
}
.login-public-copy-inner h1 {
  max-width: 25rem;
  text-wrap: pretty;
}
.login-public-art-column {
  display: flex;
  min-height: 9rem;
  flex-direction: column;
}
.login-public-art {
  position: relative;
  display: flex;
  height: 100%;
  flex-direction: column;
  justify-content: center;
  overflow: clip;
  background-size: cover;
  background-position: center;
  padding-top: 2rem;
  padding-left: 1.5rem;
  padding-bottom: 2rem;
}
.login-public-shell main + section,
.login-public-shell main + section + section,
.login-public-shell main section[aria-hidden="true"] {
  border-top: 1px solid var(--color-border);
}
.login-public-shell main section[aria-hidden="true"] {
  width: 100%;
  min-height: 3rem;
  flex: 1 1 0%;
}
.login-public-shell > section:first-of-type > div {
  display: flex;
  flex-direction: column;
  gap: 2.5rem;
  padding: 2.5rem 1.25rem 4rem;
}
.login-public-shell > section:first-of-type > div > div:first-child {
  display: flex;
  flex-direction: column;
  gap: 2.5rem;
}
.login-public-shell > section:first-of-type p {
  margin-bottom: 2rem;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  letter-spacing: 0.025em;
  color: var(--color-text-2);
  text-transform: uppercase;
}
.login-public-shell > section:first-of-type ul {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.login-public-shell > section:first-of-type a {
  font-size: 1rem;
}
.login-public-shell > section:last-of-type {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 1.25rem;
}
.login-public-shell > section:last-of-type p {
  font-size: 0.875rem;
}
@media (min-width: 40rem) {
  .login-public-art-column {
    min-height: 18rem;
  }
  .login-public-art {
    padding-top: 4rem;
    padding-left: 4rem;
    padding-bottom: 4rem;
  }
}
@media (min-width: 48rem) {
  .login-public-hero {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .login-public-hero > :not(:last-child) {
    border-right: 1px solid var(--color-border);
  }
  .login-public-copy {
    align-items: flex-start;
  }
  .login-public-copy-inner {
    align-items: flex-start;
    text-align: left;
  }
  .login-public-shell > section:first-of-type > div {
    flex-direction: row;
    justify-content: space-between;
    gap: 0;
    padding: 4rem 6rem 10rem;
  }
  .login-public-shell > section:first-of-type > div > div:first-child {
    flex-direction: row;
    gap: 5rem;
  }
  .login-public-shell > section:last-of-type {
    flex-direction: row;
    align-items: center;
    gap: 0;
    padding-inline: 6rem;
  }
}
`;

function CriticalStyles() {
  return <style dangerouslySetInnerHTML={{ __html: criticalCss }} />;
}

export default function Layout({ children }: { children: ReactNode }) {
  const { user, canAccessDashboard } = useShared<DashboardShared>();
  const navigation = useNavigation();
  const isLoading = navigation.state !== 'idle';

  if (!user || !canAccessDashboard) {
    return (
      <>
        <CriticalStyles />
        {isLoading && <div className="nav-progress loading" />}
        {children}
      </>
    );
  }

  return (
    <>
      <CriticalStyles />
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
          <div className="min-h-[calc(100vh-206px)]">{children}</div>
          <FooterNav footer={footerConfig} />
        </div>
      </ThemeContextProvider>
    </>
  );
}
