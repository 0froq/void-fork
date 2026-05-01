import { Icon } from '@iconify/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useThemeContext } from '../context/ThemeContext.tsx';
import cx from '../lib/cx.tsx';
import type { IconOption } from '../types/theme-config.ts';

const EXTERNAL_URL_RE = /^(?:[a-z]+:|\/\/)/i;

type HeaderActionItem = {
  icon?: IconOption;
  link: string;
  text: string;
};

type AppHeaderProps = {
  accountMenuItems?: Array<HeaderActionItem>;
  accountMenuLabel?: string;
  backHref?: string;
  homeHref?: string;
  title?: string;
};

const isExternalLink = (link: string) => EXTERNAL_URL_RE.test(link);

const resolveIcon = (icon: IconOption | undefined, isDark: boolean) => {
  if (!icon) {
    return undefined;
  }
  return typeof icon === 'string' ? icon : isDark ? icon.dark : icon.light;
};

function NavIcon({
  className = 'size-[1em] shrink-0',
  icon,
  isDark,
}: {
  className?: string;
  icon?: IconOption;
  isDark: boolean;
}) {
  const iconName = resolveIcon(icon, isDark);
  return iconName ? <Icon aria-hidden="true" className={className} icon={iconName} /> : null;
}

export default function AppHeader({
  accountMenuItems = [],
  accountMenuLabel = 'Account',
  backHref,
  homeHref = '/',
  title,
}: AppHeaderProps) {
  const { logoAlt, logoDark, logoLight } = useThemeContext();
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);

  const closeAccountMenu = useCallback(() => {
    setAccountMenuOpen(false);
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const updateIsDark = () => {
      setIsDark(
        document.documentElement.classList.contains('dark') ||
          document.documentElement.dataset.theme === 'dark' ||
          mediaQuery.matches,
      );
    };
    const observer = new MutationObserver(updateIsDark);

    updateIsDark();
    mediaQuery.addEventListener('change', updateIsDark);
    observer.observe(document.documentElement, {
      attributeFilter: ['class', 'data-theme'],
      attributes: true,
    });

    return () => {
      mediaQuery.removeEventListener('change', updateIsDark);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!accountMenuOpen) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (
        accountMenuRef.current &&
        event.target instanceof Node &&
        !accountMenuRef.current.contains(event.target)
      ) {
        closeAccountMenu();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [accountMenuOpen, closeAccountMenu]);

  return (
    <header className="wrapper relative flex items-center justify-between px-6 py-7">
      <div className="relative flex h-11 items-center gap-2 px-2 py-1">
        <a className="flex items-center gap-2" href={backHref ?? homeHref}>
          <div className="relative -ml-6 flex h-6 w-6 items-center justify-center">
            {backHref ? (
              <Icon
                aria-hidden="true"
                className="size-6 transition-opacity hover:opacity-50"
                icon="lucide:chevron-left"
              />
            ) : null}
          </div>
          <picture>
            <source media="(prefers-color-scheme: dark)" srcSet={logoLight} />
            <img
              alt={logoAlt}
              className="block h-4 w-auto"
              src={logoDark}
              style={{ height: '1rem', width: 'auto' }}
            />
          </picture>
        </a>
      </div>

      {accountMenuItems.length ? (
        <div className="relative flex items-center" ref={accountMenuRef}>
          <button
            aria-expanded={accountMenuOpen}
            aria-haspopup="menu"
            aria-label={accountMenuLabel}
            className="flex max-w-56 min-w-0 cursor-pointer items-center gap-2 px-2 py-2 font-sans text-sm text-primary transition-opacity hover:opacity-70 dark:text-white"
            onClick={() => setAccountMenuOpen((value) => !value)}
            title={accountMenuLabel}
            type="button"
          >
            <Icon aria-hidden="true" className="size-4 shrink-0" icon="lucide:circle-user-round" />
            <span className="min-w-0 truncate">{accountMenuLabel}</span>
          </button>
          {accountMenuOpen ? (
            <div
              className="absolute top-full right-0 z-50 mt-1 min-w-40 border border-stroke bg-white p-1 shadow-md dark:border-nickel dark:bg-primary"
              role="menu"
            >
              {accountMenuItems.map((item) => (
                <a
                  className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-primary transition-colors [corner-shape:squircle] hover:bg-primary/5 dark:text-white dark:hover:bg-white/10"
                  href={item.link}
                  key={item.link}
                  onClick={closeAccountMenu}
                  rel={isExternalLink(item.link) ? 'noreferrer' : undefined}
                  role="menuitem"
                  target={isExternalLink(item.link) ? '_blank' : undefined}
                >
                  <NavIcon className="size-4 shrink-0" icon={item.icon} isDark={isDark} />
                  {item.text}
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="h-11 w-11" />
      )}

      {title ? (
        <div className="pointer-events-none absolute top-1/2 left-1/2 hidden -translate-x-1/2 -translate-y-1/2 sm:block">
          <h2 className={cx('text-center text-xl sm:text-2xl')}>{title}</h2>
        </div>
      ) : null}
    </header>
  );
}
