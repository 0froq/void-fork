/** @jsxImportSource @voidcloud/api/admin-jsx */
export function AdminErrorPage({ message, status }: { message: string; status: number }) {
  return (
    <>
      <h1>{message}</h1>
      <p>
        {status === 401 ? (
          <a href="/admin/logout">Sign in again</a>
        ) : (
          <a href="/admin/">Return to admin</a>
        )}
      </p>
    </>
  );
}
