import type { Deployment } from "../../types";
import { DeploymentTable } from "./deployment-table";
import { Layout } from "./layout";
import { Pagination } from "./pagination";

export function DeploymentsListPage({
  deployments,
  page,
  totalPages,
  username,
  tz,
}: {
  deployments: (Deployment & { project_slug: string | null })[];
  page: number;
  totalPages: number;
  username?: string;
  tz?: string;
}) {
  return (
    <Layout title="Deployments" username={username}>
      <h1>Deployments</h1>
      <DeploymentTable deployments={deployments} showProject tz={tz} />
      <Pagination page={page} totalPages={totalPages} baseUrl="/admin/deployments" />
    </Layout>
  );
}
