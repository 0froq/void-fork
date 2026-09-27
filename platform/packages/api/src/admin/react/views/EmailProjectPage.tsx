/** @jsxImportSource @voidcloud/api/admin-jsx */
import {
  DEFAULT_EMAIL_BURST_LIMIT as DEFAULT_BURST_LIMIT,
  DEFAULT_EMAIL_MONTHLY_LIMIT as DEFAULT_MONTHLY_LIMIT,
} from '../../../email/limits.ts';
import { STATUS_COLORS, formatDateTime } from './format.ts';
import { Layout } from './Layout.tsx';
const META = 'font-size: 0.8rem; color: #666';
function domainStatusColor(status: string): string {
  if (status === 'ready' || status === 'healthy') {
    return STATUS_COLORS.success;
  }
  if (status === 'pending' || status === 'verified_only' || status === 'probe_failed') {
    return STATUS_COLORS.pending;
  }
  return STATUS_COLORS.failed;
}
type Destination = {
  id: string;
  address: string;
  status: string;
  verification_source: string;
  verified_at: string | null;
};
type Domain = {
  id: string;
  domain: string;
  inbound: string;
  inboundReason: string | null;
  outbound: string;
  outboundReason: string | null;
  management: string;
  managementReason: string | null;
  managed_by: string;
  relay_worker_name: string | null;
  relay_version: number | null;
  operation?: { id: string; status: string } | null;
};
export function EmailProjectPage({
  projectId,
  project,
  month,
  attempts,
  received,
  monthlyLimit,
  burstLimit,
  isSuspended,
  domains,
  destinations,
  senderDomain,
  tz,
  platformName,
  username,
}: {
  projectId: string;
  project: { id: string; slug: string };
  month: string;
  attempts: number;
  received: number;
  monthlyLimit?: number;
  burstLimit?: number;
  isSuspended: boolean;
  domains: Array<Domain>;
  destinations: Array<Destination>;
  senderDomain?: string;
  tz?: string;
  platformName: string;
  username?: string;
}) {
  return (
    <Layout platformName={platformName} title={`Email - ${project.slug}`} username={username}>
      <h1>
        Email &mdash; <a href={`/admin/projects/${projectId}`}>{project.slug}</a>
      </h1>

      <table>
        <tbody>
          <tr>
            <th>Project ID</th>
            <td>{projectId}</td>
          </tr>
          <tr>
            <th>Sender</th>
            <td>
              {senderDomain ? (
                <code>{`${project.slug}+noreply@${senderDomain}`}</code>
              ) : (
                <em>EMAIL_SENDER_DOMAIN is not configured for this environment</em>
              )}
            </td>
          </tr>
          <tr>
            <th>Status</th>
            <td>
              {isSuspended ? (
                <strong style="color: red">SUSPENDED</strong>
              ) : (
                <span style="color: #16a34a">active</span>
              )}
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Usage ({month})</h2>
      <table>
        <tbody>
          <tr>
            <th>Outbound recipient attempts</th>
            <td>
              {attempts} / {monthlyLimit ?? DEFAULT_MONTHLY_LIMIT}{' '}
              <span style={META}>({monthlyLimit === undefined ? 'default' : 'override'})</span>
            </td>
          </tr>
          <tr>
            <th>Inbound (received)</th>
            <td>{received}</td>
          </tr>
          <tr>
            <th>Burst cap</th>
            <td>
              {burstLimit ?? DEFAULT_BURST_LIMIT} / minute{' '}
              <span style={META}>({burstLimit === undefined ? 'default' : 'override'})</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p style={META}>
        Recipient submission attempts and inbound receipts are recorded in the platform database.
      </p>

      <h2>Controls</h2>
      <form method="post" action={`/admin/email/${projectId}/suspend`}>
        {/* Post the desired terminal state rather than a "toggle" intent, so a
            double-click cannot race two toggles and flip the switch back on. */}
        <input type="hidden" name="state" value={isSuspended ? 'active' : 'suspended'} />
        <button type="submit" class={isSuspended ? '' : 'danger'}>
          {isSuspended ? 'Unsuspend email' : 'Suspend email'}
        </button>{' '}
        <span style={META}>
          Suspending stops new outbound attempts and rejects new inbound messages with a permanent
          SMTP error. Outbound submissions that already started may still finish. There is no
          per-direction switch.
        </span>
      </form>

      <form method="post" action={`/admin/email/${projectId}/limit`} style="margin-top: 12px">
        <input type="number" name="limit" min="1" placeholder="blank = default" />
        <button type="submit">Set monthly limit</button>{' '}
        <span style={META}>Submit blank to drop the override back to the platform default.</span>
      </form>

      <form method="post" action={`/admin/email/${projectId}/burst-limit`} style="margin-top: 12px">
        <input type="number" name="burstLimit" min="1" placeholder="blank = default" />
        <button type="submit">Set burst limit</button>{' '}
        <span style={META}>Per-minute cap. Submit blank to drop the override.</span>
      </form>

      <h2>Verified destinations ({destinations.length})</h2>
      <p style={META}>
        Recipient addresses this project is allowed to send to. A <code>pending</code> row is
        waiting on the recipient clicking their verification link. Removing a row revokes it for
        this project only; the Cloudflare account-level address is deleted just when no other
        project still references it.
      </p>
      {destinations.length === 0 ? (
        <p>
          <em>No destinations yet.</em>
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Address</th>
              <th>Status</th>
              <th>Source</th>
              <th>Verified</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {destinations.map((destination) => (
              <tr key={destination.id}>
                <td>{destination.address}</td>
                <td>
                  {destination.status === 'verified' ? (
                    <span style="color: #16a34a">verified</span>
                  ) : (
                    <span style="color: #d97706">pending</span>
                  )}
                </td>
                <td>{destination.verification_source}</td>
                <td>
                  {destination.verified_at ? formatDateTime(destination.verified_at, tz) : '-'}
                </td>
                <td>
                  <form
                    method="post"
                    action={`/admin/email/${projectId}/destinations/${destination.id}/delete`}
                    data-confirm={`Remove "${destination.address}" from this project?`}
                    data-address={destination.address}
                  >
                    <button type="submit" class="danger-sm">
                      remove
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p style={META}>
        Destinations are added by the project owner through{' '}
        <code>POST /projects/:id/email/destinations</code>, which emails the recipient for consent.
        There is deliberately no operator-side "add" here: an admin cannot consent on a recipient's
        behalf.
      </p>

      <h2>Custom domains ({domains.length})</h2>
      <p style={META}>
        Exact sender and recipient domains on a Cloudflare zone. One connection owns the ingress
        Worker and catch-all; removing an assignment keeps shared resources while sibling domains
        use them. The platform stores connection credentials and never shows them here.
      </p>
      <form
        method="post"
        action={`/admin/email/${projectId}/domains/add`}
        style="margin-bottom: 12px; display: flex; gap: 8px; align-items: center"
      >
        <input
          type="text"
          name="domain"
          placeholder="mail.example.com"
          autocomplete="off"
          required
          style="width: 240px"
        />
        <input
          type="password"
          name="token"
          placeholder="API token (blank = platform credential)"
          autocomplete="off"
          style="width: 300px"
        />
        <button type="submit">Add domain</button>
      </form>
      {domains.length === 0 ? (
        <p>
          <em>No custom domains.</em>
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Domain</th>
              <th>Inbound</th>
              <th>Outbound</th>
              <th>Management</th>
              <th>Managed by</th>
              <th>Ingress worker</th>
              <th>v</th>
              <th>Latest operation</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {domains.map((domain) => (
              <tr key={domain.id}>
                <td>{domain.domain}</td>
                <td>
                  <span style={`color: ${domainStatusColor(domain.inbound)}`}>
                    {domain.inbound}
                  </span>
                  {domain.inboundReason && <small> — {domain.inboundReason}</small>}
                </td>
                <td>
                  <span style={`color: ${domainStatusColor(domain.outbound)}`}>
                    {domain.outbound}
                  </span>
                  {domain.outboundReason && <small> — {domain.outboundReason}</small>}
                </td>
                <td>
                  <span style={`color: ${domainStatusColor(domain.management)}`}>
                    {domain.management}
                  </span>
                  {domain.managementReason && <small> — {domain.managementReason}</small>}
                </td>
                <td>{domain.managed_by}</td>
                <td>{domain.relay_worker_name ?? '-'}</td>
                <td>{domain.relay_version ?? '-'}</td>
                <td>
                  {domain.operation ? (
                    <>
                      <code>{domain.operation.id}</code> ({domain.operation.status})
                    </>
                  ) : (
                    '-'
                  )}
                </td>
                <td>
                  <form
                    method="post"
                    action={`/admin/email/${projectId}/domains/${domain.domain}/rotate-secret`}
                  >
                    <button type="submit">rotate secret</button>
                  </form>
                  {/* Keep apostrophes out of the `onsubmit` text (see the Danger
                      Zone note above); the typed slug is the real confirmation
                      and is checked on the server. */}
                  <form
                    method="post"
                    action={`/admin/email/${projectId}/domains/${domain.domain}/revoke`}
                    data-confirm={`Remove "${domain.domain}"? This disables its exact assignment. Shared ingress stays while another domain uses it.`}
                    data-domain={domain.domain}
                  >
                    <input
                      type="text"
                      name="confirm"
                      placeholder={project.slug}
                      autocomplete="off"
                      required
                    />{' '}
                    <button type="submit" class="danger-sm">
                      revoke
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Layout>
  );
}
