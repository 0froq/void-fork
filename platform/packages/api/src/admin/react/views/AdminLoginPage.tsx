/** @jsxImportSource @voidcloud/api/admin-jsx */
export function AdminLoginPage({ providers }: { providers: Array<{ id: string; label: string }> }) {
  return (
    <div style="max-width: 800px; margin: 0 auto; padding: 20px">
      <h1>Void Admin</h1>
      <p>Sign in with your admin account</p>
      {providers.map(({ id, label }) => (
        <p key={id}>
          <a href={`/admin/login/${encodeURIComponent(id)}`}>Sign in with {label}</a>
        </p>
      ))}
    </div>
  );
}
