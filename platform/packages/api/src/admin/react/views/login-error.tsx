/** @jsxImportSource @voidcloud/api/admin-jsx */
export function LoginErrorPage({ message }: { message: string }) {
  return (
    <>
      <h1>Login failed</h1>
      <p>{message}</p>
    </>
  );
}
