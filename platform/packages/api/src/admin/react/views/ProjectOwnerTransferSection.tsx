/** @jsxImportSource react */

import { Button } from '@astryxdesign/core/Button';
import { useState } from 'react';
import { AdminUserTypeahead, type AdminUserSuggestion } from './AdminUserTypeahead.tsx';

export function ProjectOwnerTransferSection({ projectId }: { projectId: string }) {
  const [selected, setSelected] = useState<AdminUserSuggestion | null>(null);

  return (
    <section id="owner-transfer" className="void-admin-owner-transfer">
      <h2>Transfer Ownership</h2>
      <p>
        Transfer this project to an existing Void Platform user. You will review the ownership,
        plan, suspension, active-work, routing, and usage-counter changes before applying them.
      </p>
      <form
        className="void-admin-owner-transfer-form"
        method="post"
        action={`/admin/projects/${projectId}/owner/preview`}
      >
        <AdminUserTypeahead label="New owner" selected={selected} onChange={setSelected} />
        <input type="hidden" name="userId" value={selected?.id ?? ''} />
        <Button type="submit" label="Preview Transfer" isDisabled={!selected} />
      </form>
    </section>
  );
}
