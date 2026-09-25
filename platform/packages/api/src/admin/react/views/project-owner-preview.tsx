/** @jsxImportSource @voidcloud/api/admin-jsx */
import type { previewOperatorProjectOwner } from '../../../operator/tenant-service.ts';
import { Layout } from './layout.tsx';
type Preview = Awaited<ReturnType<typeof previewOperatorProjectOwner>>;
function suspensionLabel(owner: { suspended: boolean; suspendedReason: string | null }) {
  return owner.suspended ? `Suspended (${owner.suspendedReason ?? 'unknown reason'})` : 'Active';
}
export function ProjectOwnerPreviewPage({
  result,
  convergenceOnly,
  operationBlocked,
  projectId,
  userId,
  platformName,
  username,
}: {
  result: Preview;
  convergenceOnly: boolean;
  operationBlocked: boolean;
  projectId: string;
  userId: string;
  platformName: string;
  username?: string;
}) {
  return (
    <Layout
      platformName={platformName}
      title={`${convergenceOnly ? 'Converge' : 'Transfer'} ${result.target.slug}`}
      username={username}
    >
      <h1>
        {convergenceOnly ? 'Converge Ownership State' : 'Transfer Ownership'}: {result.target.slug}
      </h1>
      <table>
        <thead>
          <tr>
            <th>Account</th>
            <th>User</th>
            <th>Plan</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>Current owner</th>
            <td>
              {result.currentOwner.login} (<code>{result.currentOwner.id}</code>)
            </td>
            <td>{result.currentOwner.plan}</td>
            <td>{suspensionLabel(result.currentOwner)}</td>
          </tr>
          <tr>
            <th>New owner</th>
            <td>
              {result.newOwner.login} (<code>{result.newOwner.id}</code>)
            </td>
            <td>{result.newOwner.plan}</td>
            <td>{suspensionLabel(result.newOwner)}</td>
          </tr>
        </tbody>
      </table>

      {convergenceOnly ? (
        <p>
          This project is already owned by the target. This is a convergence-only operation:
          applying it repairs membership, usage-counter, routing, and account metadata without
          changing ownership. The owner's stored project role is{' '}
          <strong>{result.targetPreviousRole ?? 'none'}</strong>. Usage transfer is{' '}
          {result.usageTransfer}.
        </p>
      ) : (
        <p>
          The former owner will become a <strong>{result.formerOwnerRole}</strong>. The target's
          current project role is <strong>{result.targetPreviousRole ?? 'none'}</strong>. Usage
          transfer is {result.usageTransfer}.
        </p>
      )}

      <h2>Operation blockers</h2>
      {result.blockers.length > 0 ? (
        <>
          <ul>
            {result.blockers.map((blocker) => (
              <li key={`${blocker.kind}:${blocker.id}`}>
                {blocker.kind}: {blocker.id} ({blocker.status})
              </li>
            ))}
          </ul>
          {convergenceOnly && !operationBlocked ? (
            <p>Active work does not block convergence.</p>
          ) : null}
        </>
      ) : (
        <p>None.</p>
      )}

      <h2>Convergence</h2>
      <p>
        {result.counterUpdates.detachUserId ? (
          <>
            Usage counters: detach from <code>{result.counterUpdates.detachUserId}</code>, attach to{' '}
            <code>{result.counterUpdates.attachUserId}</code>.
          </>
        ) : (
          <>
            Usage counters: attach or reconcile with{' '}
            <code>{result.counterUpdates.attachUserId}</code>; no former-owner detachment is needed.
          </>
        )}
      </p>
      <p>Routing and account entries: {result.routingUpdates.join(', ')}</p>

      <h2>GitHub authorization provenance</h2>
      {result.github ? (
        <p>
          {result.github.repository} installation {result.github.installationId}, authorized by{' '}
          {result.github.authorizedByUserId ?? 'unknown'} ({result.github.executor}).
        </p>
      ) : (
        <p>No GitHub connection.</p>
      )}

      {!operationBlocked ? (
        <form method="post" action={`/admin/projects/${projectId}/owner`}>
          <input type="hidden" name="userId" value={userId} />
          <button type="submit" class="danger">
            {convergenceOnly ? 'Apply Convergence' : 'Apply Ownership Transfer'}
          </button>
        </form>
      ) : (
        <p>
          {convergenceOnly
            ? 'Project deletion blocks convergence.'
            : 'Resolve or cancel all active work before applying this transfer.'}
        </p>
      )}
      <p>
        <a href={`/admin/projects/${projectId}`}>Back to project</a>
      </p>
    </Layout>
  );
}
