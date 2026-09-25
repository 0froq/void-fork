/** @jsxImportSource @voidcloud/api/admin-jsx */
import { Layout } from './layout.tsx';

export function EmailOperationPage({
  label,
  status,
  error,
  operationId,
  projectId,
  platformName,
  username,
}: {
  label: string;
  status: string;
  error?: string | null;
  operationId?: string;
  projectId: string;
  platformName: string;
  username?: string;
}) {
  return (
    <Layout platformName={platformName} title={label} username={username}>
      <h1>
        {label} {status}
      </h1>
      <p>{error ?? 'The operation has not completed. Check its status before retrying.'}</p>
      <p>
        Operation ID: <code>{operationId ?? 'unavailable'}</code>
      </p>
      <a href={`/admin/email/${projectId}`}>Back to email settings</a>
    </Layout>
  );
}
