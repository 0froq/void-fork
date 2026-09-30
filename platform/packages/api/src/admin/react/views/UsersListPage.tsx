/** @jsxImportSource @voidcloud/api/admin-jsx */

import { Button } from '@astryxdesign/core/Button';
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@astryxdesign/core/Table';
import { useEffect, useState } from 'react';
import { useRequest, useView } from 'react-fate';
import { UsersPageView, usersPageRequest } from '../../fate/views.ts';
import { type AdminPageProps } from '../page-utils.ts';
import { formatDateTime } from './format.ts';
import { Layout } from './Layout.tsx';
import { Pagination } from './Pagination.tsx';
import { SearchForm } from './SearchForm.tsx';

export function UsersListPage({ path, platformName, username }: AdminPageProps) {
  const { usersPage: ref } = useRequest(usersPageRequest(path), { mode: 'stale-while-revalidate' });
  const pageData = useView(UsersPageView, ref);
  if (!pageData) {
    throw new Error('Users page data is unavailable.');
  }
  const { users, search, page, totalPages, tz } = pageData;
  const [filter, setFilter] = useState(search ?? '');
  useEffect(() => setFilter(search ?? ''), [search]);
  const selectedUser = users.find((user) => user.id === search);
  return (
    <Layout platformName={platformName} title="Users" username={username}>
      <h1>Users</h1>
      <SearchForm
        action="/admin/users"
        kind="users"
        label="Search users"
        value={filter}
        onChange={setFilter}
        initialValue={search}
        initialSelection={
          selectedUser
            ? {
                id: selectedUser.id,
                label: selectedUser.login,
                description: [selectedUser.email, selectedUser.id].filter(Boolean).join(' · '),
              }
            : undefined
        }
      />
      <Table hasHover>
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Login</TableHeaderCell>
            <TableHeaderCell>Provider</TableHeaderCell>
            <TableHeaderCell>Email</TableHeaderCell>
            <TableHeaderCell>Plan</TableHeaderCell>
            <TableHeaderCell>Role</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
            <TableHeaderCell>Created</TableHeaderCell>
            <TableHeaderCell>Actions</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((user) => (
            <TableRow key={user.id}>
              <TableCell>
                <a href={`/admin/users/${user.id}`}>{user.login}</a>
              </TableCell>
              <TableCell>{user.provider}</TableCell>
              <TableCell>{user.email ?? '-'}</TableCell>
              <TableCell>{user.plan}</TableCell>
              <TableCell>{user.role}</TableCell>
              <TableCell>{user.suspended_reason ? 'suspended' : 'active'}</TableCell>
              <TableCell>{formatDateTime(user.created_at, tz)}</TableCell>
              <TableCell>
                <form
                  method="post"
                  action={`/admin/users/${user.id}/delete`}
                  style="display: inline"
                  data-confirm={`Delete user "${user.login}" and all their projects?`}
                >
                  <Button type="submit" label="Delete" variant="destructive" size="sm" />
                </form>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {users.length === 0 && (
        <p>
          <em>No users found.</em>
        </p>
      )}
      {page != null && totalPages != null && (
        <Pagination page={page} totalPages={totalPages} baseUrl="/admin/users" />
      )}
    </Layout>
  );
}
