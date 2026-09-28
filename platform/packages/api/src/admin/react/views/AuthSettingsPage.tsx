/** @jsxImportSource @voidcloud/api/admin-jsx */

import { Button } from '@astryxdesign/core/Button';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@astryxdesign/core/Table';
import type { PlatformAdmissionPolicy, PlatformLoginConfiguration } from '@void/platform';
import type { getAuthenticationConfiguration } from '../../../operator/auth-config.ts';
import type { platformLoginTests } from '../../../schema.ts';
import { FormCheckbox, FormSelector } from './FormControls.tsx';
import { Layout } from './Layout.tsx';
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
      <Collapsible trigger="Change platform protection">
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
      </Collapsible>
      {!data.initialized ? (
        <form method="post" action={`${HOME}/initialize`}>
          <p>
            Initialize authentication settings to manage your existing login methods here. Their
            configuration is preserved; you will sign in again.
          </p>
          <Button type="submit" label="Initialize settings" />
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
                  <Button
                    type="submit"
                    label={action === 'link' ? 'Link to my account' : 'Enable tested configuration'}
                  />
                </form>
              ))}
            </section>
          )}
          <h2>Login methods</h2>
          <Table hasHover>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Method</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.methods.map((method) => (
                <TableRow key={method.id}>
                  <TableCell>{method.label}</TableCell>
                  <TableCell>
                    {method.enabled ? 'Enabled' : 'Disabled'}
                    {'activeRevision' in method && method.activeRevision !== method.revision
                      ? ' · Pending configuration'
                      : ''}
                  </TableCell>
                  <TableCell>
                    <a href={`${HOME}/connections/${encodeURIComponent(method.id)}`}>Edit</a>{' '}
                    <form
                      method="post"
                      action={`${HOME}/connections/${encodeURIComponent(method.id)}/test`}
                      style="display: inline"
                    >
                      <Button type="submit" label="Test login" size="sm" />
                    </form>{' '}
                    {method.enabled && 'revision' in method && (
                      <form
                        method="post"
                        action={`${HOME}/connections/${encodeURIComponent(method.id)}/disable`}
                        style="display: inline"
                      >
                        <input type="hidden" name="revision" value={method.revision} />
                        <Button
                          type="submit"
                          label="Disable and revoke sessions"
                          variant="destructive"
                          size="sm"
                        />
                      </form>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
            <FormSelector
              label="Signup policy"
              name="mode"
              initialValue={admission?.mode ?? 'restricted'}
              options={[
                { value: 'restricted', label: 'Invited or allowlisted users' },
                { value: 'company', label: 'Company-approved users — automatic accounts' },
                { value: 'public', label: 'Public signup — all enabled logins' },
              ]}
            />
            <p>
              For company-approved signup, select the methods whose company policies qualify a new
              user:
            </p>
            {data.methods
              .filter((method) => method.enabled && method.kind !== 'github')
              .map((method) => (
                <FormCheckbox
                  key={method.id}
                  label={method.label}
                  name="connections"
                  submitValue={method.id}
                  initialValue={
                    admission?.mode === 'company' && admission.connections.includes(method.id)
                  }
                />
              ))}
            {data.protection && (
              <FormCheckbox
                label="Anyone who passes Cloudflare Access protection"
                name="access"
                submitValue="true"
                initialValue={admission?.mode === 'company' && admission.access}
              />
            )}
            <p>
              Automatically created accounts are ordinary users. Changing signup policy does not
              remove Access protection.
            </p>
            <Button type="submit" label="Save signup policy" />
          </form>
        </>
      )}
    </Layout>
  );
}
