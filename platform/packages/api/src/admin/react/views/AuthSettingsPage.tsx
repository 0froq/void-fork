/** @jsxImportSource @voidcloud/api/admin-jsx */

import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Text';
import type { PlatformLoginConfiguration } from '@void/platform';
import { useRequest, useView } from 'react-fate';
import { AuthSettingsView, authSettingsRequest } from '../../fate/views.ts';
import { type AdminPageProps } from '../page-utils.ts';
import { Layout } from './Layout.tsx';

const HOME = '/admin/config/auth';
const LOGIN_KINDS = [
  { kind: 'github', label: 'GitHub' },
  { kind: 'google', label: 'Google' },
  { kind: 'oidc', label: 'Generic OIDC' },
  { kind: 'cloudflare-access', label: 'Cloudflare Access' },
] as const satisfies ReadonlyArray<{ kind: PlatformLoginConfiguration['kind']; label: string }>;

export function AuthSettingsPage({ path, platformName, username }: AdminPageProps) {
  const { authSettings: ref } = useRequest(authSettingsRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const pageData = useView(AuthSettingsView, ref);
  if (!pageData) {
    throw new Error('Authentication settings are unavailable.');
  }
  const { data, tested } = pageData;
  return (
    <Layout platformName={platformName} title="Authentication settings" username={username}>
      <div className="void-admin-auth-settings">
        <header className="void-admin-auth-intro">
          <Heading level={1}>Authentication</Heading>
          <p>Manage how people reach the platform and sign in.</p>
        </header>

        <section aria-labelledby="platform-protection-heading">
          <Card>
            <div className="void-admin-auth-section-header">
              <div>
                <Heading level={2} id="platform-protection-heading">
                  Platform protection
                </Heading>
                <p>Control access to the platform before visitors reach a login page.</p>
              </div>
              <Badge
                label={
                  data.protection ? 'Cloudflare Access enabled' : 'Cloudflare Access not enabled'
                }
                variant={data.protection ? 'success' : 'neutral'}
              />
            </div>
            <div className="void-admin-auth-protection-details">
              <div className="void-admin-auth-protection-steps">
                <div>
                  <h3>Enable Cloudflare Access</h3>
                  <p>
                    Create or connect an Access application and verify every platform origin. The
                    installing CLI needs the installation's recovery credentials and Access setup
                    permission.
                  </p>
                  <pre>void platform config auth protection enable --installation &lt;id&gt;</pre>
                </div>
                <div>
                  <h3>Disable Cloudflare Access</h3>
                  <p>First change any signup policy that relies on Access.</p>
                  <pre>void platform config auth protection disable --installation &lt;id&gt;</pre>
                </div>
              </div>
              <p className="void-admin-auth-note">
                Either change revokes human sessions. Access applications remain for deliberate
                cleanup; login methods and deployed applications keep their own settings.
              </p>
            </div>
          </Card>
        </section>

        {!data.initialized ? (
          <Card>
            <Heading level={2}>Set up authentication settings</Heading>
            <p>
              Initialize settings to manage your existing login methods here. Their configuration is
              preserved; you will sign in again.
            </p>
            <form method="post" action={`${HOME}/initialize`}>
              <Button type="submit" label="Initialize settings" />
            </form>
          </Card>
        ) : (
          <>
            {tested && (
              <section aria-labelledby="verified-login-heading">
                <Card>
                  <div className="void-admin-auth-section-header">
                    <div>
                      <Heading level={2} id="verified-login-heading">
                        Login verified
                      </Heading>
                      <p>Review this identity before linking or enabling the tested method.</p>
                    </div>
                    <Badge label="Ready to review" variant="success" />
                  </div>
                  <dl className="void-admin-auth-identity">
                    <div>
                      <dt>Account</dt>
                      <dd>{tested.login || tested.subject}</dd>
                    </div>
                    <div>
                      <dt>Provider</dt>
                      <dd>{tested.issuer}</dd>
                    </div>
                    <div>
                      <dt>Identity</dt>
                      <dd>{tested.subject}</dd>
                    </div>
                  </dl>
                  <div className="void-admin-auth-actions">
                    {(['link', 'enable'] as const).map((action) => (
                      <form
                        key={action}
                        method="post"
                        action={`${HOME}/connections/${encodeURIComponent(tested.connection_id)}/${action}`}
                      >
                        <input type="hidden" name="revision" value={tested.revision} />
                        <input type="hidden" name="testId" value={tested.id} />
                        <Button
                          type="submit"
                          label={
                            action === 'link' ? 'Link to my account' : 'Enable tested configuration'
                          }
                          variant={action === 'link' ? 'secondary' : 'primary'}
                        />
                      </form>
                    ))}
                  </div>
                </Card>
              </section>
            )}

            <section aria-labelledby="login-methods-heading">
              <Card>
                <div className="void-admin-auth-section-header">
                  <div>
                    <Heading level={2} id="login-methods-heading">
                      Login methods
                    </Heading>
                    <p>Choose the identity providers people can use to sign in.</p>
                  </div>
                  <Badge
                    label={`${data.methods.filter((method) => method.enabled).length} active`}
                    variant="neutral"
                  />
                </div>
                {data.methods.length ? (
                  <div className="void-admin-auth-method-list">
                    {data.methods.map((method) => (
                      <div className="void-admin-auth-method" key={method.id}>
                        <div className="void-admin-auth-method-info">
                          <div className="void-admin-auth-method-title">
                            <strong>{method.label}</strong>
                            <Badge
                              label={method.enabled ? 'Enabled' : 'Disabled'}
                              variant={method.enabled ? 'success' : 'neutral'}
                            />
                            {'activeRevision' in method &&
                              method.activeRevision !== method.revision && (
                                <Badge label="Pending configuration" variant="warning" />
                              )}
                          </div>
                          <span className="void-admin-auth-method-type">
                            {LOGIN_KINDS.find(({ kind }) => kind === method.kind)?.label ??
                              method.kind}
                          </span>
                        </div>
                        <div className="void-admin-auth-actions">
                          <Button
                            as="a"
                            href={`${HOME}/connections/${encodeURIComponent(method.id)}`}
                            label="Edit"
                            variant="secondary"
                            size="sm"
                          />
                          <form
                            method="post"
                            action={`${HOME}/connections/${encodeURIComponent(method.id)}/test`}
                          >
                            <Button
                              type="submit"
                              label="Test login"
                              variant="secondary"
                              size="sm"
                            />
                          </form>
                          {method.enabled && 'revision' in method && (
                            <form
                              method="post"
                              action={`${HOME}/connections/${encodeURIComponent(method.id)}/disable`}
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
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="void-admin-auth-empty">No login methods configured yet.</p>
                )}
                <div className="void-admin-auth-add-methods">
                  <h3>Add a login method</h3>
                  <div className="void-admin-auth-actions">
                    {LOGIN_KINDS.map(({ kind, label }) => (
                      <Button
                        key={kind}
                        as="a"
                        href={`${HOME}/new?kind=${kind}`}
                        label={label}
                        variant="secondary"
                        size="sm"
                      />
                    ))}
                  </div>
                </div>
              </Card>
            </section>
          </>
        )}
        <section aria-labelledby="account-access-heading">
          <Card>
            <div className="void-admin-auth-section-header">
              <div>
                <Heading level={2} id="account-access-heading">
                  Who can join?
                </Heading>
                <p>Set the signup policy, invite people, and manage individual grants on Access.</p>
              </div>
              <Button
                as="a"
                href="/admin/signup-control"
                label="Manage access"
                variant="secondary"
              />
            </div>
          </Card>
        </section>
      </div>
    </Layout>
  );
}
