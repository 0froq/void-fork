/** @jsxImportSource @voidcloud/api/admin-jsx */

import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@astryxdesign/core/Table';
import { Heading } from '@astryxdesign/core/Text';
import { useState, type FocusEvent } from 'react';
import { useRequest, useView } from 'react-fate';
import { SignupView, signupRequest } from '../../fate/views.ts';
import { type AdminPageProps } from '../page-utils.ts';
import { formatAbsoluteDate } from './format.ts';
import { FormCheckbox, FormSelector, FormTextArea, FormTextInput } from './FormControls.tsx';
import { Layout } from './Layout.tsx';
import { Pagination } from './Pagination.tsx';

function BooleanBadge({ value }: { value: boolean }) {
  return <Badge label={value ? 'Yes' : 'No'} variant={value ? 'success' : 'neutral'} />;
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className="void-admin-access-copy-value">
      <label>
        <span>{label}</span>
        <input
          aria-label={label}
          readOnly
          value={value}
          onFocus={(event: FocusEvent<HTMLInputElement>) => event.currentTarget.select()}
        />
      </label>
      <Button
        type="button"
        label={copied ? 'Copied' : 'Copy'}
        variant="secondary"
        size="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setFailed(false);
          } catch {
            setFailed(true);
          }
        }}
      />
      {failed && <span role="status">Select the value to copy it manually.</span>}
    </div>
  );
}

function DeliveryBadge({ status }: { status: string | null }) {
  if (status === 'sent') {
    return <Badge label="Sent" variant="success" />;
  }
  if (status === 'failed') {
    return <Badge label="Failed" variant="error" />;
  }
  if (status === 'unavailable') {
    return <Badge label="Email off" variant="neutral" />;
  }
  return <Badge label="Not recorded" variant="neutral" />;
}

export function SignupControlPage({ path, platformName, username }: AdminPageProps) {
  const { signupControl: ref } = useRequest(signupRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const pageData = useView(SignupView, ref);
  if (!pageData) {
    throw new Error('Access settings are unavailable.');
  }
  const {
    enabled,
    admission,
    initialized,
    revision,
    methods,
    protection,
    connections,
    directEntries,
    invitations,
    page,
    totalPages,
    emailEnabled,
    connectCommand,
    inviteUrl,
    result,
  } = pageData;
  const mode = admission?.mode ?? (enabled ? 'restricted' : 'public');
  const companyMethods = methods.filter((method) => method.enabled && method.kind !== 'github');

  return (
    <Layout platformName={platformName} title="Access" username={username}>
      <div className="void-admin-access-page">
        <header className="void-admin-access-intro">
          <Heading level={1}>Access</Heading>
          <p>Decide who can join this platform and manage invitations and individual grants.</p>
        </header>

        <section aria-labelledby="access-policy-heading">
          <Card>
            <div className="void-admin-access-section-header">
              <div>
                <Heading level={2} id="access-policy-heading">
                  Who can join?
                </Heading>
                <p>These rules apply when someone creates a platform account.</p>
              </div>
              <Badge
                label={
                  mode === 'public'
                    ? 'Public'
                    : mode === 'company'
                      ? 'Company or approved'
                      : 'Approved only'
                }
                variant={mode === 'public' ? 'warning' : 'neutral'}
              />
            </div>
            {initialized ? (
              <form
                method="post"
                action="/admin/signup-control/policy"
                className="void-admin-access-form"
              >
                <input type="hidden" name="revision" value={revision ?? 0} />
                <FormSelector
                  label="Signup policy"
                  name="mode"
                  initialValue={mode}
                  options={[
                    { value: 'restricted', label: 'Only individually approved people' },
                    { value: 'company', label: 'Company-approved or individually approved people' },
                    { value: 'public', label: 'Anyone with an enabled login method' },
                  ]}
                  width={420}
                />
                <p className="void-admin-access-muted">
                  {mode === 'restricted'
                    ? 'An invitation or direct grant is required before someone can create an account.'
                    : mode === 'company'
                      ? 'People who meet a selected company policy or have an individual grant can join.'
                      : 'Anyone with an enabled login method can join. Individual invitations are unnecessary.'}
                </p>
                <div className="void-admin-access-company-policy">
                  <h3>Company-approved methods</h3>
                  <p>
                    Select which existing login checks qualify someone when company signup is
                    chosen.
                  </p>
                  <div className="void-admin-access-checkboxes">
                    {companyMethods.map((method) => (
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
                    {protection && (
                      <FormCheckbox
                        label="Anyone who passes Cloudflare Access protection"
                        name="access"
                        submitValue="true"
                        initialValue={admission?.mode === 'company' && admission.access}
                      />
                    )}
                    {companyMethods.length === 0 && !protection && (
                      <p>
                        No company-approved methods are available. Configure one in{' '}
                        <a href="/admin/config/auth">Authentication</a> before selecting this
                        policy.
                      </p>
                    )}
                  </div>
                </div>
                <p className="void-admin-access-muted">
                  New accounts are ordinary users. Changing this policy does not change Cloudflare
                  Access protection.
                </p>
                <Button type="submit" label="Save signup policy" />
              </form>
            ) : (
              <div className="void-admin-access-form">
                <p>
                  This installation uses the legacy signup restriction. Initialize{' '}
                  <a href="/admin/config/auth">Authentication settings</a> to choose all three
                  policies.
                </p>
                <form
                  method="post"
                  action="/admin/signup-control/toggle"
                  className="void-admin-access-inline-form"
                >
                  <span>
                    Signup is{' '}
                    {enabled
                      ? 'restricted to approved people'
                      : 'open to anyone with an enabled login'}
                    .
                  </span>
                  <Button
                    type="submit"
                    label={enabled ? 'Open signup' : 'Restrict signup'}
                    variant="secondary"
                  />
                </form>
              </div>
            )}
          </Card>
        </section>

        <section aria-labelledby="access-invite-heading">
          <Card>
            <div className="void-admin-access-section-header">
              <div>
                <Heading level={2} id="access-invite-heading">
                  Invite people
                </Heading>
                <p>
                  {mode === 'public'
                    ? 'Signup is public. Share the platform address with anyone you want to join.'
                    : emailEnabled
                      ? 'Grant signup access to verified email addresses and send invitation emails.'
                      : 'Grant signup access to verified email addresses, then share the connection details yourself.'}
                </p>
              </div>
              <Badge
                label={emailEnabled ? 'Email enabled' : 'Email not enabled'}
                variant={emailEnabled ? 'success' : 'neutral'}
              />
            </div>
            {result === 'invited' && (
              <p role="status" className="void-admin-access-notice">
                Access grants were created. Check each invitation below for its email delivery
                result.
              </p>
            )}
            {mode !== 'public' && (
              <form
                method="post"
                action="/admin/invitations/send"
                className="void-admin-access-form"
              >
                <FormTextArea
                  label="Email addresses"
                  name="email"
                  placeholder="person@example.com, teammate@example.com"
                  required
                  rows={3}
                  width={440}
                />
                <p className="void-admin-access-muted">
                  Each person must sign in with a login method that supplies the same verified email
                  address.
                </p>
                <Button type="submit" label={emailEnabled ? 'Invite and email' : 'Grant access'} />
              </form>
            )}
            <div className="void-admin-access-share">
              <h3>{emailEnabled ? 'Share connection details' : 'Share these details manually'}</h3>
              <CopyValue label="Platform invitation page" value={inviteUrl} />
              <CopyValue label="Void CLI connection command" value={connectCommand} />
            </div>
          </Card>
        </section>

        <section aria-labelledby="access-grants-heading">
          <Card>
            <div className="void-admin-access-section-header">
              <div>
                <Heading level={2} id="access-grants-heading">
                  Direct grants
                </Heading>
                <p>
                  Approve a GitHub login, email or domain pattern, or exact provider identity.
                  Invitation grants appear in the history below.
                  {mode === 'public' &&
                    ' While signup is public, grants do not limit who can join.'}
                </p>
              </div>
            </div>
            <form
              method="post"
              action="/admin/signup-control/add"
              className="void-admin-access-fields"
            >
              <FormSelector
                label="Grant type"
                name="type"
                initialValue="github"
                options={[
                  { value: 'github', label: 'GitHub username' },
                  { value: 'email', label: 'Email or domain pattern' },
                ]}
                width={210}
              />
              <FormTextArea
                label="Pattern"
                name="pattern"
                placeholder="username, person@example.com, *@company.com"
                required
                rows={3}
                width={360}
              />
              <FormTextInput label="Note" name="note" placeholder="Optional" width={180} />
              <Button type="submit" label="Add grant" />
            </form>
            {connections.length > 0 && (
              <form
                method="post"
                action="/admin/signup-control/add"
                className="void-admin-access-fields"
              >
                <input type="hidden" name="type" value="identity" />
                <FormSelector
                  label="Login connection"
                  name="connectionId"
                  initialValue={connections[0]?.id ?? ''}
                  options={connections.map((connection) => ({
                    value: connection.id,
                    label: `${connection.label} (${connection.id})`,
                  }))}
                  width={250}
                  hasSearch
                />
                <FormTextInput
                  label="Provider subject"
                  name="subject"
                  placeholder="Exact provider subject"
                  required
                  maxLength={255}
                  width={340}
                />
                <FormTextInput label="Note" name="note" placeholder="Optional" width={180} />
                <Button type="submit" label="Add identity" />
              </form>
            )}
            <p className="void-admin-access-muted">
              Identity grants match the selected login connection and provider subject exactly,
              including case. Email is not inferred or linked.
            </p>
            <div className="void-admin-access-table">
              <Table hasHover>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Type</TableHeaderCell>
                    <TableHeaderCell>Grant</TableHeaderCell>
                    <TableHeaderCell>Note</TableHeaderCell>
                    <TableHeaderCell>Accepted</TableHeaderCell>
                    <TableHeaderCell>Deployed</TableHeaderCell>
                    <TableHeaderCell>Actions</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {directEntries.map((entry) => (
                    <TableRow
                      key={
                        entry.type === 'identity'
                          ? `${entry.type}-${entry.connectionId}-${entry.subject}`
                          : `${entry.type}-${entry.pattern}`
                      }
                    >
                      <TableCell>{entry.type}</TableCell>
                      <TableCell>
                        {entry.type === 'identity'
                          ? `${entry.connectionId}: ${entry.subject}`
                          : entry.pattern}
                      </TableCell>
                      <TableCell>{entry.note || '—'}</TableCell>
                      <TableCell>
                        <BooleanBadge value={entry.accepted} />
                      </TableCell>
                      <TableCell>
                        <BooleanBadge value={entry.deployed} />
                      </TableCell>
                      <TableCell>
                        <form method="post" action="/admin/signup-control/delete">
                          <input type="hidden" name="index" value={entry.index} />
                          <Button type="submit" label="Remove" variant="destructive" size="sm" />
                        </form>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {directEntries.length === 0 && (
              <p className="void-admin-access-muted">No direct grants yet.</p>
            )}
          </Card>
        </section>

        <section aria-labelledby="access-history-heading">
          <Card>
            <div className="void-admin-access-section-header">
              <div>
                <Heading level={2} id="access-history-heading">
                  Invitation history
                </Heading>
                <p>
                  Invitation status and email delivery are tracked separately. Invitations do not
                  expire.
                </p>
              </div>
            </div>
            <div className="void-admin-access-table">
              <Table hasHover>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Email</TableHeaderCell>
                    <TableHeaderCell>Access</TableHeaderCell>
                    <TableHeaderCell>Email delivery</TableHeaderCell>
                    <TableHeaderCell>Invited by</TableHeaderCell>
                    <TableHeaderCell>Created</TableHeaderCell>
                    <TableHeaderCell>Accepted</TableHeaderCell>
                    <TableHeaderCell>Revoked</TableHeaderCell>
                    <TableHeaderCell>Actions</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invitations.map((invitation) => (
                    <TableRow key={invitation.id}>
                      <TableCell>{invitation.email}</TableCell>
                      <TableCell>
                        <Badge
                          label={invitation.status}
                          variant={
                            invitation.status === 'pending'
                              ? 'warning'
                              : invitation.status === 'revoked'
                                ? 'error'
                                : 'success'
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <DeliveryBadge status={invitation.email_delivery_status} />
                      </TableCell>
                      <TableCell>{invitation.invited_by_login ?? invitation.invited_by}</TableCell>
                      <TableCell>
                        {invitation.created_at ? formatAbsoluteDate(invitation.created_at) : '—'}
                      </TableCell>
                      <TableCell>
                        {invitation.accepted_at ? formatAbsoluteDate(invitation.accepted_at) : '—'}
                      </TableCell>
                      <TableCell>
                        {invitation.revoked_at
                          ? `${formatAbsoluteDate(invitation.revoked_at)} by ${invitation.revoked_by_login ?? invitation.revoked_by ?? '?'}`
                          : '—'}
                      </TableCell>
                      <TableCell>
                        {invitation.status === 'pending' && (
                          <form method="post" action="/admin/invitations/revoke">
                            <input type="hidden" name="id" value={invitation.id} />
                            <Button type="submit" label="Revoke" variant="destructive" size="sm" />
                          </form>
                        )}
                        {invitation.status === 'accepted' && invitation.grantIndex !== null && (
                          <form method="post" action="/admin/signup-control/delete">
                            <input type="hidden" name="index" value={invitation.grantIndex} />
                            <Button
                              type="submit"
                              label="Remove signup grant"
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
            </div>
            {invitations.length === 0 && (
              <p className="void-admin-access-muted">No invitations yet.</p>
            )}
            <Pagination page={page} totalPages={totalPages} baseUrl="/admin/signup-control" />
          </Card>
        </section>
      </div>
    </Layout>
  );
}
