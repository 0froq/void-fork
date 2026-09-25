/** @jsxImportSource @voidcloud/api/admin-jsx */
import type { PlatformAdmissionPolicy, PlatformLoginConfiguration } from '@void/platform';
import type { getAuthenticationConfiguration } from '../../../operator/auth-config.ts';
import type { platformLoginTests } from '../../../schema.ts';
import { Layout } from './layout.tsx';
const HOME = '/admin/config/auth';
const LOGIN_KINDS = [
  'github',
  'google',
  'oidc',
  'cloudflare-access',
] as const satisfies ReadonlyArray<PlatformLoginConfiguration['kind']>;
type Data = Awaited<ReturnType<typeof getAuthenticationConfiguration>>;
type Tested = typeof platformLoginTests.$inferSelect;
export function AuthSettingsPage({
  data,
  tested,
  admission,
  platformName,
  username,
}: {
  data: Data;
  tested?: Tested;
  admission?: PlatformAdmissionPolicy;
  platformName: string;
  username?: string;
}) {
  return (
    <Layout platformName={platformName} title="Authentication settings" username={username}>
      <h1>Authentication settings</h1>
      <p>
        Platform protection:{' '}
        <strong>
          {data.protection ? 'Cloudflare Access enabled' : 'Cloudflare Access not enabled'}
        </strong>
        .
      </p>
      <p>Access protection and login methods are configured independently.</p>
      <details>
        <summary>Change platform protection</summary>
        <p>
          Use the installing CLI to create or connect a Cloudflare Access application, verify every
          platform origin, and sign in through the company policy. The CLI needs the installation's
          recovery credentials and separate Cloudflare Access setup permission.
        </p>
        <pre>void platform config auth protection enable --installation &lt;id&gt;</pre>
        <p>To remove protection, first change any signup policy that relies on Access, then run:</p>
        <pre>void platform config auth protection disable --installation &lt;id&gt;</pre>
        <p>
          Changes revoke existing human sessions. Access applications remain available for
          deliberate cleanup. Login methods and deployed applications keep their own settings.
        </p>
      </details>
      {!data.initialized ? (
        <form method="post" action={`${HOME}/initialize`}>
          <p>
            Initialize authentication settings to manage your existing login methods here. Their
            configuration is preserved; you will sign in again.
          </p>
          <button type="submit">Initialize settings</button>
        </form>
      ) : (
        <>
          {tested && (
            <section style="margin: 24px 0; padding: 16px; border: 1px solid #aaa">
              <h3>Login verified</h3>
              <p>
                Account: <strong>{tested.login || tested.subject}</strong>
              </p>
              <p>Provider: {tested.issuer}</p>
              <p>Identity: {tested.subject}</p>
              <p>
                Review this identity before linking it to your administrator account or enabling the
                tested configuration.
              </p>
              {(['link', 'enable'] as const).map((action) => (
                <form
                  key={action}
                  method="post"
                  action={`${HOME}/connections/${encodeURIComponent(tested.connection_id)}/${action}`}
                  style="display: inline-block; margin-right: 12px"
                >
                  <input type="hidden" name="revision" value={tested.revision} />
                  <input type="hidden" name="testId" value={tested.id} />
                  <button type="submit">
                    {action === 'link' ? 'Link to my account' : 'Enable tested configuration'}
                  </button>
                </form>
              ))}
            </section>
          )}
          <h2>Login methods</h2>
          <table>
            <thead>
              <tr>
                <th>Method</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.methods.map((method) => (
                <tr key={method.id}>
                  <td>{method.label}</td>
                  <td>
                    {method.enabled ? 'Enabled' : 'Disabled'}
                    {'activeRevision' in method && method.activeRevision !== method.revision
                      ? ' · Pending configuration'
                      : ''}
                  </td>
                  <td>
                    <a href={`${HOME}/connections/${encodeURIComponent(method.id)}`}>Edit</a>{' '}
                    <form
                      method="post"
                      action={`${HOME}/connections/${encodeURIComponent(method.id)}/test`}
                      style="display: inline"
                    >
                      <button type="submit">Test login</button>
                    </form>{' '}
                    {method.enabled && 'revision' in method && (
                      <form
                        method="post"
                        action={`${HOME}/connections/${encodeURIComponent(method.id)}/disable`}
                        style="display: inline"
                      >
                        <input type="hidden" name="revision" value={method.revision} />
                        <button type="submit">Disable and revoke sessions</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style="margin-top: 16px">
            Add:{' '}
            {LOGIN_KINDS.map((kind) => (
              <span key={kind}>
                <a href={`${HOME}/new?kind=${kind}`}>
                  {kind === 'cloudflare-access'
                    ? 'Cloudflare Access'
                    : kind === 'oidc'
                      ? 'Generic OIDC'
                      : kind === 'github'
                        ? 'GitHub'
                        : 'Google'}
                </a>
                {' · '}
              </span>
            ))}
          </p>
          <h2>Who can join?</h2>
          <form
            method="post"
            action={`${HOME}/admission`}
            style="display: grid; gap: 12px; max-width: 700px"
          >
            <input type="hidden" name="revision" value={'revision' in data ? data.revision : 0} />
            <select name="mode" defaultValue={admission?.mode ?? 'restricted'}>
              <option value="restricted">Invited or allowlisted users</option>
              <option value="company">Company-approved users — automatic accounts</option>
              <option value="public">Public signup — all enabled logins</option>
            </select>
            <p>
              For company-approved signup, select the methods whose company policies qualify a new
              user:
            </p>
            {data.methods
              .filter((method) => method.enabled && method.kind !== 'github')
              .map((method) => (
                <label key={method.id}>
                  <input
                    type="checkbox"
                    name="connections"
                    value={method.id}
                    checked={
                      admission?.mode === 'company' && admission.connections.includes(method.id)
                    }
                  />{' '}
                  {method.label}
                </label>
              ))}
            {data.protection && (
              <label>
                <input
                  type="checkbox"
                  name="access"
                  value="true"
                  checked={admission?.mode === 'company' && admission.access}
                />{' '}
                Anyone who passes Cloudflare Access protection
              </label>
            )}
            <p>
              Automatically created accounts are ordinary users. Changing signup policy does not
              remove Access protection.
            </p>
            <button type="submit">Save signup policy</button>
          </form>
        </>
      )}
    </Layout>
  );
}
