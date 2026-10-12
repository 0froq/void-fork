import { Menu } from '@base-ui/react/menu';
import { Icon } from '@iconify/react';
import { useThemeContext } from '../context/ThemeContext.tsx';

const EXTERNAL_URL_RE = /^(?:[a-z]+:|\/\/)/i;

type HeaderActionItem = Readonly<{
  icon?: string;
  link: string;
  text: string;
}>;

type AppHeaderProps = Readonly<{
  accountMenuItems?: ReadonlyArray<HeaderActionItem>;
  accountMenuLabel?: string;
}>;

const isExternalLink = (link: string) => EXTERNAL_URL_RE.test(link);

export default function AppHeader({
  accountMenuItems = [],
  accountMenuLabel = 'Account',
}: AppHeaderProps) {
  const { logoAlt, logoDark, logoLight } = useThemeContext();

  return (
    <header className="wrapper dashboard-header">
      <div className="dashboard-brand">
        <a className="dashboard-brand-link" href="/">
          <div className="dashboard-brand-spacer" />
          <picture>
            <source media="(prefers-color-scheme: dark)" srcSet={logoLight} />
            <img alt={logoAlt} className="dashboard-logo" src={logoDark} />
          </picture>
        </a>
      </div>

      {accountMenuItems.length ? (
        <Menu.Root modal={false}>
          <div className="dashboard-account">
            <Menu.Trigger
              aria-label={accountMenuLabel}
              className="dashboard-account-trigger"
              title={accountMenuLabel}
            >
              <span className="dashboard-account-icon">
                <Icon
                  aria-hidden="true"
                  className="dashboard-account-icon"
                  icon="lucide:circle-user-round"
                />
              </span>
              <span className="dashboard-account-label">{accountMenuLabel}</span>
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner
                align="end"
                className="dashboard-menu-positioner"
                collisionPadding={16}
                side="bottom"
                sideOffset={6}
              >
                <Menu.Popup className="dashboard-menu">
                  {accountMenuItems.map((item) => (
                    <Menu.LinkItem
                      className="dashboard-menu-item"
                      closeOnClick
                      href={item.link}
                      key={item.link}
                      rel={isExternalLink(item.link) ? 'noreferrer' : undefined}
                      target={isExternalLink(item.link) ? '_blank' : undefined}
                    >
                      <span className="dashboard-account-icon">
                        {item.icon ? (
                          <Icon
                            aria-hidden="true"
                            className="dashboard-account-icon"
                            icon={item.icon}
                          />
                        ) : null}
                      </span>
                      <span>{item.text}</span>
                    </Menu.LinkItem>
                  ))}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </div>
        </Menu.Root>
      ) : (
        <div className="dashboard-account-spacer" />
      )}
    </header>
  );
}
