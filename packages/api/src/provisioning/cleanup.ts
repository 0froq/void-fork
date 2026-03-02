import type { ApiEnv } from "../env";
import type { Context } from "hono";
import { getProjectResources, getDomainsByProjectId } from "../db";
import {
  deleteD1Database,
  deleteKVNamespace,
  deleteR2Bucket,
  deleteQueue,
  deleteCustomHostname,
} from "./cloudflare-api";
import { DEFAULT_DISPATCH_NAMESPACE } from "../constants";
import type { Project } from "../types";

/**
 * Run best-effort Cloudflare resource cleanup for a project.
 * Returns an array of warning strings for any non-fatal failures.
 * This does NOT delete the project from the database — call `deleteProjectCascade` after.
 */
export async function cleanupProjectResources(
  c: Context<ApiEnv>,
  projectId: string,
  project: Pick<Project, "slug">,
): Promise<string[]> {
  const warnings: string[] = [];
  const warn = (msg: string) => (err: unknown) => {
    warnings.push(`${msg}: ${err instanceof Error ? err.message : String(err)}`);
  };

  const [resources, projectDomains] = await Promise.all([
    getProjectResources(c.get("db"), projectId),
    getDomainsByProjectId(c.get("db"), projectId),
  ]);

  const cleanup: Promise<void>[] = [];

  // CF resource cleanup (D1, KV, R2, Queue)
  for (const resource of resources) {
    const del =
      resource.type === "d1"
        ? deleteD1Database(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, resource.cf_id)
        : resource.type === "kv"
          ? deleteKVNamespace(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, resource.cf_id)
          : resource.type === "r2"
            ? deleteR2Bucket(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, resource.cf_id)
            : deleteQueue(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, resource.cf_id);
    cleanup.push(del.catch(warn(`Failed to delete ${resource.type} resource ${resource.cf_id}`)));
  }

  // Worker dispatch deletion
  const dispatchNamespace = c.env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
  const workerName = `user-${project.slug}`;
  cleanup.push(
    fetch(
      `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${workerName}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${c.env.CF_API_TOKEN}` } },
    )
      .then(async (cfRes) => {
        if (!cfRes.ok && cfRes.status !== 404) {
          warnings.push(`Failed to delete worker ${workerName}: ${await cfRes.text()}`);
        }
      })
      .catch(warn(`Failed to delete worker ${workerName}`)),
  );

  // R2 assets (paginated, batch delete per page)
  cleanup.push(
    (async () => {
      let cursor: string | undefined;
      do {
        const listed = await c.env.ASSETS.list({ prefix: `${projectId}/`, cursor });
        if (listed.objects.length > 0) {
          await c.env.ASSETS.delete(listed.objects.map((obj) => obj.key));
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    })().catch(warn("Failed to clean up R2 assets")),
  );

  // Clear cron scheduler DO if project had crons
  cleanup.push(
    c.env.ROUTING.get(project.slug)
      .then(async (raw) => {
        if (raw && JSON.parse(raw).hasCrons) {
          const cronId = c.env.CRON_SCHEDULER.idFromName(projectId);
          await c.env.CRON_SCHEDULER.get(cronId).fetch(
            new Request("https://do/clear", { method: "POST" }),
          );
        }
      })
      .catch(warn("Failed to clear cron scheduler")),
  );

  // KV routing entry
  cleanup.push(c.env.ROUTING.delete(project.slug).catch(warn("Failed to delete routing entry")));

  // Queue routing KV entries
  for (const q of resources.filter((r) => r.type === "queue")) {
    cleanup.push(
      c.env.ROUTING.delete(`queue:${q.cf_id}`).catch(warn("Failed to delete queue routing entry")),
    );
  }

  // Custom hostnames from CF + KV
  for (const domain of projectDomains) {
    cleanup.push(
      deleteCustomHostname(c.env.CF_ZONE_ID, c.env.CF_API_TOKEN, domain.cf_hostname_id).catch(
        warn(`Failed to delete custom hostname ${domain.hostname}`),
      ),
    );
    cleanup.push(
      c.env.ROUTING.delete(`domain:${domain.hostname}`).catch(
        warn("Failed to delete domain routing entry"),
      ),
    );
  }

  await Promise.all(cleanup);
  return warnings;
}
