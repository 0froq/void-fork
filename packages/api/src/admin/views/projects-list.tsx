import type { ProjectRow } from "./projects-table";
import { ProjectsTable } from "./projects-table";
import { Layout } from "./layout";
import { Pagination } from "./pagination";

export function ProjectsListPage({
  projects,
  search,
  page,
  totalPages,
  siteDomain,
  username,
}: {
  projects: ProjectRow[];
  search?: string;
  page?: number;
  totalPages?: number;
  siteDomain: string;
  username?: string;
}) {
  return (
    <Layout title="Projects" username={username}>
      <h1>Projects</h1>
      <form method="get" action="/admin/projects" style="margin-bottom: 10px">
        <input
          type="text"
          name="search"
          placeholder="Search projects..."
          value={search ?? ""}
          id="search-input"
        />{" "}
        <button type="submit">Search</button>
        {search && (
          <>
            {" "}
            | <a href="/admin/projects">Clear</a>
          </>
        )}
      </form>
      <ProjectsTable projects={projects} siteDomain={siteDomain} />
      {page != null && totalPages != null && (
        <Pagination page={page} totalPages={totalPages} baseUrl="/admin/projects" />
      )}
      <script
        dangerouslySetInnerHTML={{
          __html: `
        (function() {
          var input = document.getElementById('search-input');
          var rows = document.querySelectorAll('table tbody tr');
          input.addEventListener('input', function() {
            var q = this.value.toLowerCase();
            rows.forEach(function(row) {
              row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
            });
          });
        })();
      `,
        }}
      />
    </Layout>
  );
}
