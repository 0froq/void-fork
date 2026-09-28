/** @jsxImportSource @voidcloud/api/admin-jsx */
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@astryxdesign/core/Table';
import { Heading } from '@astryxdesign/core/Text';
import type { Invitation } from '../../../types.ts';
import { formatAbsoluteDate } from './format.ts';
import { FormTextArea } from './FormControls.tsx';
import { Layout } from './Layout.tsx';
import { Pagination } from './Pagination.tsx';

type InvitationRow = Invitation & {
  invited_by_login: string | null;
  revoked_by_login: string | null;
};

function StatusBadge({ status }: { status: Invitation['status'] }) {
  return (
    <Badge
      label={status}
      variant={status === 'pending' ? 'warning' : status === 'revoked' ? 'error' : 'neutral'}
    />
  );
}

export function InvitationsPage({
  invitations,
  page,
  totalPages,
  platformName,
  username,
}: {
  invitations: ReadonlyArray<InvitationRow>;
  page: number;
  totalPages: number;
  platformName: string;
  username?: string;
}) {
  return (
    <Layout platformName={platformName} title="Invitations" username={username}>
      <Heading level={1}>Invitations</Heading>

      <form
        method="post"
        action="/admin/invitations/send"
        style="margin-bottom: 20px; display: flex; gap: 8px; align-items: flex-start"
      >
        <FormTextArea
          label="Email addresses"
          name="email"
          placeholder="user@example.com, teammate@example.com"
          required
          rows={3}
          width={360}
        />
        <Button type="submit" label="Send Invites" />
      </form>

      <Table hasHover>
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Email</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
            <TableHeaderCell>Invited By</TableHeaderCell>
            <TableHeaderCell>Sent</TableHeaderCell>
            <TableHeaderCell>Accepted At</TableHeaderCell>
            <TableHeaderCell>Revoked</TableHeaderCell>
            <TableHeaderCell>Actions</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invitations.map((inv) => (
            <TableRow key={inv.id}>
              <TableCell>{inv.email}</TableCell>
              <TableCell>
                <StatusBadge status={inv.status} />
              </TableCell>
              <TableCell>{inv.invited_by_login ?? inv.invited_by}</TableCell>
              <TableCell>{inv.created_at ? formatAbsoluteDate(inv.created_at) : '-'}</TableCell>
              <TableCell>{inv.accepted_at ? formatAbsoluteDate(inv.accepted_at) : '-'}</TableCell>
              <TableCell>
                {inv.revoked_at
                  ? `${formatAbsoluteDate(inv.revoked_at)} by ${inv.revoked_by_login ?? inv.revoked_by ?? '?'}`
                  : '-'}
              </TableCell>
              <TableCell>
                {inv.status === 'pending' && (
                  <form method="post" action="/admin/invitations/revoke" style="display:inline">
                    <input type="hidden" name="id" value={inv.id} />
                    <Button type="submit" label="Revoke" variant="destructive" size="sm" />
                  </form>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {invitations.length === 0 && (
        <p>
          <em>No invitations yet.</em>
        </p>
      )}

      <Pagination page={page} totalPages={totalPages} baseUrl="/admin/invitations" />
    </Layout>
  );
}
