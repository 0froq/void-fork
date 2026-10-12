import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { Icon } from '@iconify/react';
import logoDark from '../assets/logos/void-dark.svg';
import logoLight from '../assets/logos/void-light.svg';

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
  return (
    <header className="wrapper dashboard-header">
      <div className="dashboard-brand">
        <a className="dashboard-brand-link" href="/">
          <div className="dashboard-brand-spacer" />
          <picture>
            <source media="(prefers-color-scheme: dark)" srcSet={logoLight} />
            <img alt="Void" className="dashboard-logo" src={logoDark} />
          </picture>
        </a>
      </div>

      {accountMenuItems.length ? (
        <div className="dashboard-account">
          <DropdownMenu
            alignment="end"
            button={{
              label: accountMenuLabel,
              variant: 'ghost',
              title: accountMenuLabel,
              icon: (
                <Icon
                  aria-hidden="true"
                  className="dashboard-account-icon"
                  icon="lucide:circle-user-round"
                />
              ),
            }}
            hasChevron={false}
            items={accountMenuItems.map((item) => ({
              id: item.link,
              label: item.text,
              icon: item.icon ? (
                <Icon aria-hidden="true" className="dashboard-account-icon" icon={item.icon} />
              ) : undefined,
              onClick: () => {
                if (isExternalLink(item.link)) {
                  window.open(item.link, '_blank', 'noopener,noreferrer');
                } else {
                  window.location.assign(item.link);
                }
              },
            }))}
          />
        </div>
      ) : (
        <div className="dashboard-account-spacer" />
      )}
    </header>
  );
}
