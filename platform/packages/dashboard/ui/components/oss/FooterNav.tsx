import { Icon } from '@iconify/react';
import type {
  FooterColumn,
  FooterConfig,
  FooterLink,
  FooterSocialLink,
} from '../../types/theme-config.ts';

type FooterNavProps = Readonly<{
  footer?: FooterConfig;
}>;

const socialIconName = (icon: string) => {
  const key = icon.toLowerCase();
  return key === 'twitter' || key === 'x' ? 'simple-icons:x' : `simple-icons:${key}`;
};

const socialLabelMap: Record<string, string> = {
  bluesky: 'Bluesky',
  discord: 'Discord',
  github: 'GitHub',
  twitter: 'X.com',
  x: 'X.com',
};

const getSocialLabel = (social: FooterSocialLink) =>
  social.label ? social.label : socialLabelMap[social.icon.toLowerCase()] || social.icon;

export default function FooterNav({ footer }: FooterNavProps) {
  const footerNav: ReadonlyArray<FooterColumn> = footer?.nav ?? [];
  const footerSocial: ReadonlyArray<FooterSocialLink> = footer?.social ?? [];
  const footerCopyright =
    footer?.copyright || `© ${new Date().getFullYear()} VoidZero Inc. All Rights Reserved.`;

  return (
    <>
      <section className="wrapper wrapper--ticks dashboard-footer">
        <div className="dashboard-footer-nav">
          <div className="dashboard-footer-columns">
            {footerNav.map((column) => (
              <div key={column.title}>
                <p className="dashboard-footer-title">{column.title}</p>
                <ul className="dashboard-footer-links">
                  {column.items.map((item: FooterLink) => (
                    <li key={item.link}>
                      <a className="dashboard-footer-link" href={item.link}>
                        {item.text}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {footerSocial.length ? (
            <div>
              <p className="dashboard-footer-title">Social</p>
              <ul className="dashboard-footer-links">
                {footerSocial.map((social) => (
                  <li key={social.link}>
                    <a
                      className="dashboard-footer-link dashboard-social-link"
                      href={social.link}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      <Icon
                        aria-hidden="true"
                        className="dashboard-social-icon"
                        icon={socialIconName(social.icon)}
                      />
                      {getSocialLabel(social)}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </section>
      <section className="wrapper wrapper--ticks dashboard-footer dashboard-footer-copyright">
        <p>{footerCopyright}</p>
      </section>
    </>
  );
}
