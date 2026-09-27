/** @jsxImportSource @voidcloud/api/admin-jsx */
import { useEffect, type ReactNode } from 'react';
import { formatPlatformPageTitle } from '../../../platform-identity.ts';

export const ADMIN_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: monospace; line-height: 1.5; }
  a { color: #2563eb; }
  a:hover { text-decoration: underline; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 12px 12px 12px 0; border-bottom: 1px solid #ccc; font-size: 0.8rem; }
  th { font-weight: 600; }
  pre { background: #f5f5f5; padding: 10px; white-space: pre-wrap; word-break: break-word; overflow-x: auto; }
  button, input, select { background: white; border: 1px solid black; border-radius: 0; padding: 4px 10px; font-family: monospace; font-size: 0.85rem; line-height: 1.5; }
  button { cursor: pointer; }
  button.danger { color: red; border-color: red; }
  button.danger-sm { color: red; border-color: red; font-size: 0.7rem; padding: 2px 6px; }
  h1 { margin-bottom: 10px; }
  h2 { margin-top: 60px; margin-bottom: 10px; }
  tr.build-active { background: #fef9c3; }
`;

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
  useEffect(() => {
    document.title = formatPlatformPageTitle(title, platformName);
  }, [title, platformName]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const button = target.closest<HTMLButtonElement>('.copy-btn');
      const copy = button?.dataset.copy;
      if (!button || !copy) {
        return;
      }
      void navigator.clipboard.writeText(copy).then(() => {
        const previous = button.textContent;
        button.textContent = 'Copied!';
        setTimeout(() => {
          button.textContent = previous;
        }, 1500);
      });
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

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
    <div style="max-width: 1100px; margin: 0 auto; padding: 20px; padding-bottom: 60px">
      <nav style="display: flex; justify-content: space-between; padding-bottom: 10px; margin-bottom: 20px; border-bottom: 1px solid #ccc">
        <span>
          <strong>Void Admin</strong> &mdash; <a href="/admin/">Dashboard</a> |{' '}
          <a href="/admin/users">Users</a> | <a href="/admin/projects">Projects</a> |{' '}
          <a href="/admin/deployments">Deployments</a> |{' '}
          <a href="/admin/cli-versions">CLI Versions</a> |{' '}
          <a href="/admin/signup-control">Signup</a> | <a href="/admin/config/auth">Settings</a> |{' '}
          <a href="/admin/email">Email</a> | <a href="/admin/invitations">Invitations</a>
        </span>
        <span>
          {username && <>{username} | </>}
          <a href="/admin/logout">Logout</a>
        </span>
      </nav>
      {children}
    </div>
  );
}
