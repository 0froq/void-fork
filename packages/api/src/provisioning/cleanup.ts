import type { Context } from 'hono';
import { DEFAULT_DISPATCH_NAMESPACE } from '../constants';
import { getAllProjectDeployments, getProjectResources, getDomainsByProjectId } from '../db';
import type { ApiEnv } from '../env';
import {
  getLegacyProjectWorkerName,
  getProjectDeploymentWorkerName,
  getProjectQueueName,
} from '../naming';
import type { Project } from '../types';
import {
  deleteD1Database,
  deleteKVNamespace,
  deleteR2Bucket,
  deleteQueue,
  deleteCustomHostname,
  deleteHyperdrive,
} from './cloudflare-api';

/**
 * Run best-effort Cloudflare resource cleanup for a project.
 * Returns an array of warning strings for any non-fatal failures.
 * This does NOT delete the project from the database — call `deleteProjectCascade` after.
 */
export async function cleanupProjectResources(
  c: Context<ApiEnv>,
  projectId: string,
  project: Pick<Project, 'slug'>,
): Promise<Array<string>> {
  const warnings: Array<string> = [];
  const warn = (msg: string) => (err: unknown) => {
    warnings.push(`${msg}: ${err instanceof Error ? err.message : String(err)}`);
  };

  const [projectDeployments, resources, projectDomains] = await Promise.all([
    getAllProjectDeployments(c.get('db'), projectId),
    getProjectResources(c.get('db'), projectId),
    getDomainsByProjectId(c.get('db'), projectId),
  ]);

  const dispatchNamespace = c.env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
  const workerNames = new Set([
    getLegacyProjectWorkerName(project.slug),
    ...projectDeployments.map((deployment) =>
      getProjectDeploymentWorkerName(project.slug, deployment.id),
    ),
  ]);

  // Delete scripts before queue resources so CF no longer sees queue bindings in attached Workers.
  await Promise.all(
    Array.from(workerNames, (workerName) =>
      fetch(
        `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${workerName}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${c.env.CF_API_TOKEN}` } },
      )
        .then(async (cfRes) => {
          if (!cfRes.ok && cfRes.status !== 404) {
            warnings.push(`Failed to delete worker ${workerName}: ${await cfRes.text()}`);
          }
        })
        .catch(warn(`Failed to delete worker ${workerName}`)),
    ),
  );

  const cleanup: Array<Promise<void>> = [];

  // CF resource cleanup (D1, KV, R2, Queue — user-provisioned resources)
  for (const resource of resources) {
    const del =
      resource.type === 'd1'
        ? deleteD1Database(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, resource.cf_id)
        : resource.type === 'kv'
          ? deleteKVNamespace(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, resource.cf_id)
          : resource.type === 'r2'
            ? deleteR2Bucket(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, resource.cf_id)
            : resource.type === 'hyperdrive'
              ? deleteHyperdrive(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, resource.cf_id)
              : deleteQueue(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, resource.cf_id);
    cleanup.push(del.catch(warn(`Failed to delete ${resource.type} resource ${resource.cf_id}`)));
  }

  // Clear cron scheduler DO if project had crons
  cleanup.push(
    c.env.ROUTING.get(project.slug)
      .then(async (raw) => {
        if (raw && JSON.parse(raw).hasCrons) {
          const cronId = c.env.CRON_SCHEDULER.idFromName(projectId);
          await c.env.CRON_SCHEDULER.get(cronId).fetch(
            new Request('https://do/clear', { method: 'POST' }),
          );
        }
      })
      .catch(warn('Failed to clear cron scheduler')),
  );

  // KV routing entry
  cleanup.push(c.env.ROUTING.delete(project.slug).catch(warn('Failed to delete routing entry')));

  // Queue routing KV entries
  for (const q of resources.filter((r) => r.type === 'queue')) {
    cleanup.push(
      c.env.ROUTING.delete(`queue:${getProjectQueueName(projectId, q.binding_name)}`).catch(
        warn('Failed to delete queue routing entry'),
      ),
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
        warn('Failed to delete domain routing entry'),
      ),
    );
  }

  await Promise.all(cleanup);
  return warnings;
}
