/** @jsxImportSource react */

import { Button } from '@astryxdesign/core/Button';
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@astryxdesign/core/Table';
import {
  Typeahead,
  TypeaheadItem,
  type SearchSource,
  type SearchableItem,
} from '@astryxdesign/core/Typeahead';
import { useMemo, useState } from 'react';
import { useFateClient } from 'react-fate';
import type { ProjectMemberRole, User } from '../../../types.ts';
import { UsersPageView, usersPageRequest } from '../../fate/views.ts';
import { formatDateTime } from './format.ts';
import { FormSelector } from './FormControls.tsx';

type TeamMember = Readonly<{
  user: Readonly<{ id: string; login: string; email: string | null }>;
  role: ProjectMemberRole;
  createdAt: string;
}>;
type PendingInvitation = Readonly<{
  id: string;
  targetUserId: string;
  email: string;
  role: ProjectMemberRole;
  expiresAt: string;
}>;
type UserSuggestion = SearchableItem<{ email: string }>;

const roleOptions = [
  { value: 'reader', label: 'Reader' },
  { value: 'collaborator', label: 'Collaborator' },
  { value: 'admin', label: 'Admin' },
];

export function ProjectTeamSection({
  projectId,
  owner,
  members,
  invitations,
  tz,
}: {
  projectId: string;
  owner: Readonly<{ id: string; login: string }> | null;
  members: ReadonlyArray<TeamMember>;
  invitations: ReadonlyArray<PendingInvitation>;
  tz?: string;
}) {
  const fate = useFateClient();
  const [selected, setSelected] = useState<UserSuggestion | null>(null);
  const excluded = useMemo(
    () =>
      new Set([
        owner?.id,
        ...members.map(({ user }) => user.id),
        ...invitations.map((i) => i.targetUserId),
      ]),
    [owner?.id, members, invitations],
  );
  const source = useMemo<SearchSource<UserSuggestion>>(
    () => ({
      bootstrap: () => [],
      search: async (query: string) => {
        const { usersPage: ref } = await fate.request(
          usersPageRequest(`/admin/users?search=${encodeURIComponent(query)}`),
          { mode: 'network-only' },
        );
        if (!ref) {
          return [];
        }
        const { data } = (await fate.readView(UsersPageView, ref)) as unknown as {
          data: { users: Array<User> };
        };
        return data.users
          .filter((user) => user.email && !excluded.has(user.id))
          .map((user) => ({
            id: user.id,
            label: user.login,
            auxiliaryData: { email: user.email! },
          }));
      },
    }),
    [fate, excluded],
  );

  return (
    <section id="team" className="void-admin-project-team">
      <h2>Team members ({members.length + 1})</h2>
      <p>
        Invite registered users to collaborate on this project. They get access after accepting an
        invitation.
      </p>
      <div className="void-admin-team-table-scroll">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>User</TableHeaderCell>
              <TableHeaderCell>Role</TableHeaderCell>
              <TableHeaderCell>Joined</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>
                {owner ? (
                  <a href={`/admin/users/${owner.id}`}>{owner.login}</a>
                ) : (
                  'Owner account unavailable'
                )}
              </TableCell>
              <TableCell>Owner</TableCell>
              <TableCell>—</TableCell>
              <TableCell>
                <a href="#owner-transfer">Transfer ownership to change the owner</a>
              </TableCell>
            </TableRow>
            {members.map(({ user, role, createdAt }) => (
              <TableRow key={user.id}>
                <TableCell>
                  <a href={`/admin/users/${user.id}`}>{user.login}</a>
                  {user.email && <span className="void-admin-team-email">{user.email}</span>}
                </TableCell>
                <TableCell>{role}</TableCell>
                <TableCell>{formatDateTime(createdAt, tz)}</TableCell>
                <TableCell>
                  <div className="void-admin-team-actions">
                    <form
                      method="post"
                      action={`/admin/projects/${projectId}/team/${user.id}/role`}
                    >
                      <FormSelector
                        label={`Role for ${user.login}`}
                        name="role"
                        options={roleOptions}
                        initialValue={role}
                        width={160}
                      />
                      <Button type="submit" label="Save role" size="sm" />
                    </form>
                    <form
                      method="post"
                      action={`/admin/projects/${projectId}/team/${user.id}/remove`}
                      data-confirm={`Remove ${user.login} from this project?`}
                    >
                      <Button type="submit" label="Remove" variant="destructive" size="sm" />
                    </form>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <h3>Invite team member</h3>
      <form
        className="void-admin-team-invite"
        method="post"
        action={`/admin/projects/${projectId}/team/invite`}
      >
        <Typeahead
          label="Search registered users"
          placeholder="Search by login or email"
          searchSource={source}
          value={selected}
          onChange={setSelected}
          onChangeQuery={() => setSelected(null)}
          renderItem={(item: UserSuggestion) => (
            <TypeaheadItem item={item} description={item.auxiliaryData?.email} />
          )}
          minQueryLength={2}
          width="min(100%, 320px)"
          emptySearchResultsText="No eligible users found."
        />
        <input type="hidden" name="email" value={selected?.auxiliaryData?.email ?? ''} />
        <FormSelector
          label="Project role"
          name="role"
          options={roleOptions}
          initialValue="reader"
          width={180}
        />
        <Button type="submit" label="Invite" isDisabled={!selected} />
      </form>

      {invitations.length > 0 && (
        <>
          <h3>Pending invitations ({invitations.length})</h3>
          <p>
            If email delivery is unavailable, share the invitation ID and ask the user to run{' '}
            <code>void project team accept &lt;invitation-id&gt;</code>.
          </p>
          <div className="void-admin-team-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Email</TableHeaderCell>
                  <TableHeaderCell>Role</TableHeaderCell>
                  <TableHeaderCell>Invitation ID</TableHeaderCell>
                  <TableHeaderCell>Expires</TableHeaderCell>
                  <TableHeaderCell>Action</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invitations.map((invitation) => (
                  <TableRow key={invitation.id}>
                    <TableCell>{invitation.email}</TableCell>
                    <TableCell>{invitation.role}</TableCell>
                    <TableCell>
                      <code>{invitation.id}</code>
                    </TableCell>
                    <TableCell>{formatDateTime(invitation.expiresAt, tz)}</TableCell>
                    <TableCell>
                      <form
                        method="post"
                        action={`/admin/projects/${projectId}/team/invitations/${invitation.id}/revoke`}
                        data-confirm={`Revoke the invitation for ${invitation.email}?`}
                      >
                        <Button type="submit" label="Revoke" variant="destructive" size="sm" />
                      </form>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </section>
  );
}
