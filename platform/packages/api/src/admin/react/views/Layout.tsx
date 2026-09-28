/** @jsxImportSource @voidcloud/api/admin-jsx */
import { AppShell } from '@astryxdesign/core/AppShell';
import { SideNav, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav';
import { TopNav, TopNavHeading } from '@astryxdesign/core/TopNav';
import { useRouter } from '@void/react';
import { useEffect, type ReactNode } from 'react';
import { formatPlatformPageTitle } from '../../../platform-identity.ts';

export function Layout({
  title,
  platformName,
  username,
  children,
}: {
  title: string;
  platformName: string;
  username?: string;
  children: ReactNode;
}) {
  const path = useRouter().path;
  useEffect(() => {
    document.title = formatPlatformPageTitle(title, platformName);
  }, [title, platformName]);

  useEffect(() => {
    const onSubmit = (event: SubmitEvent) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) {
        return;
      }
      const message = form.dataset.confirm;
      if (message && !window.confirm(message)) {
        event.preventDefault();
      }
    };
    document.addEventListener('submit', onSubmit, true);
    return () => document.removeEventListener('submit', onSubmit, true);
  }, []);

  return (
    <AppShell
      height="auto"
      contentPadding={6}
      topNav={
        <TopNav
          label="Platform administration"
          heading={<TopNavHeading heading={platformName} subheading="Admin" />}
          endContent={
            <div style="display: flex; align-items: center; gap: 16px">
              {username && <span>{username}</span>}
              <a href="/admin/logout">Log out</a>
            </div>
          }
        />
      }
      sideNav={
        <SideNav label="Admin sections" collapsible>
          <SideNavSection title="Overview">
            <SideNavItem label="Dashboard" href="/admin/" isSelected={path === '/admin/'} />
          </SideNavSection>
          <SideNavSection title="Applications">
            <SideNavItem
              label="Projects"
              href="/admin/projects"
              isSelected={path.startsWith('/admin/projects')}
            />
            <SideNavItem
              label="Deployments"
              href="/admin/deployments"
              isSelected={path.startsWith('/admin/deployments')}
            />
          </SideNavSection>
          <SideNavSection title="People">
            <SideNavItem
              label="Users"
              href="/admin/users"
              isSelected={path.startsWith('/admin/users')}
            />
            <SideNavItem
              label="Invitations"
              href="/admin/invitations"
              isSelected={path === '/admin/invitations'}
            />
          </SideNavSection>
          <SideNavSection title="Platform">
            <SideNavItem
              label="Authentication"
              href="/admin/config/auth"
              isSelected={path.startsWith('/admin/config/auth')}
            />
            <SideNavItem
              label="Email"
              href="/admin/email"
              isSelected={path.startsWith('/admin/email')}
            />
            <SideNavItem
              label="Signup"
              href="/admin/signup-control"
              isSelected={path === '/admin/signup-control'}
            />
            <SideNavItem
              label="CLI Versions"
              href="/admin/cli-versions"
              isSelected={path === '/admin/cli-versions'}
            />
          </SideNavSection>
        </SideNav>
      }
    >
      <div className="void-admin-content">{children}</div>
    </AppShell>
  );
}
