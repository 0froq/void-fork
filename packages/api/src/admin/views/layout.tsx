import type { Child } from "hono/jsx";

export function Layout({
  title,
  username,
  children,
}: {
  title: string;
  username?: string;
  children: Child;
}) {
  return (
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title} - Void Admin</title>
        <style>{`
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: system-ui, -apple-system, sans-serif; background: #f8f9fa; color: #1a1a1a; line-height: 1.5; }
          nav { background: #1a1a1a; color: white; padding: 0.75rem 1.5rem; display: flex; align-items: center; gap: 2rem; }
          nav a { color: #a0a0a0; text-decoration: none; font-size: 0.875rem; }
          nav a:hover, nav a.active { color: white; }
          nav .brand { font-weight: 600; color: white; font-size: 1rem; }
          main { max-width: 1200px; margin: 2rem auto; padding: 0 1.5rem; }
          h1 { font-size: 1.5rem; margin-bottom: 1.5rem; }
          .card { background: white; border-radius: 8px; border: 1px solid #e5e7eb; padding: 1.5rem; margin-bottom: 1rem; }
          table { width: 100%; border-collapse: collapse; }
          th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #e5e7eb; font-size: 0.875rem; }
          th { font-weight: 600; color: #6b7280; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
          a { color: #2563eb; text-decoration: none; }
          a:hover { text-decoration: underline; }
          .badge { display: inline-block; padding: 0.125rem 0.5rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 500; }
          .badge-green { background: #dcfce7; color: #166534; }
          .badge-red { background: #fef2f2; color: #991b1b; }
          .badge-blue { background: #dbeafe; color: #1e40af; }
          .badge-gray { background: #f3f4f6; color: #374151; }
          .badge-purple { background: #f3e8ff; color: #6b21a8; }
          .stat { text-align: center; }
          .stat-value { font-size: 2rem; font-weight: 700; }
          .stat-label { font-size: 0.875rem; color: #6b7280; }
          .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
          .btn { display: inline-block; padding: 0.375rem 0.75rem; border-radius: 6px; font-size: 0.875rem; border: 1px solid #d1d5db; background: white; cursor: pointer; }
          .btn:hover { background: #f9fafb; }
          .btn-danger { border-color: #fca5a5; color: #dc2626; }
          .btn-danger:hover { background: #fef2f2; }
          .btn-primary { background: #2563eb; color: white; border-color: #2563eb; }
          .btn-primary:hover { background: #1d4ed8; }
          form.inline { display: inline; }
          input[type="text"], select { padding: 0.375rem 0.75rem; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.875rem; }
          .search-form { margin-bottom: 1.5rem; display: flex; gap: 0.5rem; }
          .mb-1 { margin-bottom: 1rem; }
          .pagination { display: flex; align-items: center; gap: 0.5rem; margin-top: 1rem; justify-content: center; }
          .pagination a, .pagination span { padding: 0.375rem 0.75rem; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.875rem; }
          .pagination a:hover { background: #f9fafb; text-decoration: none; }
          .pagination .disabled { color: #9ca3af; pointer-events: none; }
          .pagination .current { background: #2563eb; color: white; border-color: #2563eb; }
        `}</style>
      </head>
      <body>
        <nav>
          <span class="brand">Void Admin</span>
          <a href="/admin/">Dashboard</a>
          <a href="/admin/users">Users</a>
          <a href="/admin/projects">Projects</a>
          <a href="/admin/deployments">Deployments</a>
          <span style="margin-left: auto; display: flex; align-items: center; gap: 1rem">
            {username && <span style="color: #a0a0a0; font-size: 0.875rem">{username}</span>}
            <a href="/admin/logout">Logout</a>
          </span>
        </nav>
        <main>{children}</main>
        <script
          dangerouslySetInnerHTML={{
            __html: `document.addEventListener('click',function(e){var b=e.target.closest('.copy-btn');if(!b)return;navigator.clipboard.writeText(b.dataset.copy).then(function(){var t=b.textContent;b.textContent='Copied!';setTimeout(function(){b.textContent=t},1500)})})`,
          }}
        />
      </body>
    </html>
  );
}
