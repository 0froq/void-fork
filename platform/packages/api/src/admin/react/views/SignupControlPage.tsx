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
import type { PlatformAdmissionPolicy } from '@void/platform';
import type { AllowlistEntryStatus } from '../../../db.ts';
import { FormSelector, FormTextArea, FormTextInput } from './FormControls.tsx';
import { Layout } from './Layout.tsx';

function BooleanBadge({ value }: { value: boolean }) {
  return <strong style={`color: ${value ? 'green' : '#666'}`}>{value ? 'yes' : 'no'}</strong>;
}

export function SignupControlPage({
  enabled,
  entries,
  platformName,
  username,
  admission,
  connections,
}: {
  enabled: boolean;
  entries: ReadonlyArray<AllowlistEntryStatus>;
  platformName: string;
  username?: string;
  admission?: PlatformAdmissionPolicy;
  connections: ReadonlyArray<{ id: string; kind: string; label: string }>;
}) {
  return (
    <Layout platformName={platformName} title="Signup Control" username={username}>
      <h1>Signup Control</h1>
      {admission?.mode === 'company' && (
        <p>
          Company-approved users can join automatically. Manage the company policy in{' '}
          <a href="/admin/config/auth">authentication settings</a>.
        </p>
      )}

      {/* Toggle */}
      <form method="post" action="/admin/signup-control/toggle" style="margin-bottom: 20px">
        <span>
          Signup restriction:{' '}
          <strong style={enabled ? 'color: red' : 'color: green'}>
            {enabled ? 'ON (restricted)' : 'OFF (open)'}
          </strong>
        </span>{' '}
        <Button
          type="submit"
          label={enabled ? 'Disable' : 'Enable'}
          variant={enabled ? 'destructive' : 'secondary'}
        />
      </form>

      {/* Add entry form */}
      <form
        method="post"
        action="/admin/signup-control/add"
        style="margin-bottom: 20px; display: flex; gap: 8px; align-items: flex-start"
      >
        <FormSelector
          label="Grant type"
          name="type"
          initialValue="github"
          options={[
            { value: 'github', label: 'GitHub username' },
            { value: 'email', label: 'Email / pattern' },
          ]}
          width={210}
        />
        <FormTextArea
          label="Pattern"
          name="pattern"
          placeholder="username, teammate@example.com, *@domain.com"
          required
          rows={3}
          width={360}
        />
        <FormTextInput label="Note" name="note" placeholder="Optional" width={180} />
        <Button type="submit" label="Add" />
      </form>

      {connections.length > 0 && (
        <form
          method="post"
          action="/admin/signup-control/add"
          style="margin-bottom: 20px; display: flex; gap: 8px; align-items: flex-start"
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
            width={360}
          />
          <FormTextInput label="Note" name="note" placeholder="Optional" width={180} />
          <Button type="submit" label="Add identity" />
        </form>
      )}
      <p>
        Identity grants match the selected login connection and provider subject exactly, including
        case. Email is not inferred or linked.
      </p>

      {/* Entries table */}
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
          {entries.map((entry, i) => (
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
              <TableCell>{entry.note || '-'}</TableCell>
              <TableCell>
                <BooleanBadge value={entry.accepted} />
              </TableCell>
              <TableCell>
                <BooleanBadge value={entry.deployed} />
              </TableCell>
              <TableCell>
                <form method="post" action="/admin/signup-control/delete" style="display: inline">
                  <input type="hidden" name="index" value={String(i)} />
                  <Button type="submit" label="Delete" variant="destructive" size="sm" />
                </form>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {entries.length === 0 && (
        <p>
          <em>
            No entries.{' '}
            {enabled
              ? 'All signups are blocked. Add entries to allow specific users.'
              : 'All signups are allowed.'}
          </em>
        </p>
      )}
    </Layout>
  );
}
