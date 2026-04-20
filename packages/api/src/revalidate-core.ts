import type { Context } from 'hono';
import { R2_CONCURRENCY, uploadPool } from './concurrency';
import { SITE_DOMAIN } from './constants';
import { getDomainsByProjectId } from './db';
import type { ApiEnv } from './env';
import {
  denormalizeIsrPath,
  isrCacheKey,
  isrCachePrefix,
  isrEdgeCacheUrl,
  resolveCurrentIsrDeployments,
  type IsrRoutingTarget,
} from './isr-cache';
import { purgeZoneCache } from './provisioning/cloudflare-api';

interface RevalidateProject {
  slug: string;
  active_deployment_id: string | null;
}

interface RevalidateRequestBody {
  paths?: string[];
  all?: boolean;
}

/**
 * Purge ISR content for a project.
 *
 * Two-layer purge:
 *   1. KV (R2) — scan `<projectId>/isr/v2/<deploymentId>/*` across every
 *      deployment id in the union. Each id gets exactly one prefix scan.
 *   2. Edge cache — purge URLs of the form
 *      `https://<hostname>/<path>?__void_isr=<deploymentId>` (+ `__void=json`
 *      variant). `<deploymentId>` is resolved per-hostname because the slug
 *      and custom-domain routing entries may have drifted apart after a
 *      partial-failure deploy (see `deploy.ts` catch branch that keeps the
 *      deploy live when the domain-routing loop fails).
 *
 * Exactly one `purgeZoneCache` call is issued per invocation (it batches
 * internally at 100 URLs per CF API request).
 */
export async function runRevalidate(
  c: Context<ApiEnv>,
  projectId: string,
  project: RevalidateProject,
  body: RevalidateRequestBody,
): Promise<Response> {
  const db = c.get('db');
  const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;

  const customDomains = await getDomainsByProjectId(db, projectId);
  // Only active domains are actually routed by the deploy handler (see
  // `deploy.ts` — `if (domain.status === 'active')` gates the KV write).
  const activeCustomDomains = customDomains.filter((d) => d.status === 'active');

  const targets: IsrRoutingTarget[] = [
    { hostname: `${project.slug}.${siteDomain}`, routingKey: project.slug },
    ...activeCustomDomains.map((d) => ({
      hostname: d.hostname,
      routingKey: `domain:${d.hostname}`,
    })),
  ];

  const { perHostname, union } = await resolveCurrentIsrDeployments(
    c.env.ROUTING,
    targets,
    project.active_deployment_id,
  );

  if (body.all) {
    // Collect pathnames across all deployment namespaces so the edge
    // purge has an accurate list (any path stored under any id becomes
    // a candidate for purge under every hostname × every id).
    const pathnameSet = new Set<string>();

    for (const deploymentId of union) {
      const prefix = isrCachePrefix(projectId, deploymentId);
      let cursor: string | undefined;

      do {
        const listed = await c.env.ISR_CACHE.list({ prefix, cursor });
        if (listed.keys.length > 0) {
          for (const key of listed.keys) {
            const normalized = key.name.slice(prefix.length);
            pathnameSet.add(denormalizeIsrPath(normalized));
          }
          await uploadPool(listed.keys, R2_CONCURRENCY, (key) => c.env.ISR_CACHE.delete(key.name));
        }
        cursor = listed.list_complete ? undefined : listed.cursor;
      } while (cursor);
    }

    await purgeEdgeCache(c, perHostname, Array.from(pathnameSet));
    // `purged` = unique pathnames purged (mirrors what the caller asked for,
    // not the raw count of KV keys deleted across all deployment namespaces).
    return c.json({ purged: pathnameSet.size });
  }

  if (!body.paths || !Array.isArray(body.paths) || body.paths.length === 0) {
    return c.json({ error: 'provide `paths` array or `all: true`' }, 400);
  }

  // Purge specific paths across every deployment namespace.
  for (const deploymentId of union) {
    for (const path of body.paths) {
      const key = isrCacheKey(projectId, deploymentId, path);
      await c.env.ISR_CACHE.delete(key);
    }
  }

  await purgeEdgeCache(c, perHostname, body.paths);
  // `purged` = unique path entries the caller asked for. The cross-namespace
  // KV deletes above are an implementation detail of the drift-handling hedge.
  return c.json({ purged: body.paths.length });
}

async function purgeEdgeCache(
  c: Context<ApiEnv>,
  perHostname: Map<string, Set<string>>,
  pathnames: string[],
): Promise<void> {
  if (pathnames.length === 0 || perHostname.size === 0) {
    return;
  }

  try {
    const urls: string[] = [];
    for (const [hostname, ids] of perHostname) {
      for (const id of ids) {
        for (const pathname of pathnames) {
          urls.push(isrEdgeCacheUrl(hostname, pathname, id, 'html'));
          urls.push(isrEdgeCacheUrl(hostname, pathname, id, 'json'));
        }
      }
    }
    if (urls.length === 0) {
      return;
    }
    // `purgeZoneCache` batches internally at 100 URLs per CF API request.
    await purgeZoneCache(c.env.CF_ZONE_ID, c.env.CF_API_TOKEN, urls);
  } catch {
    // Best-effort: KV is already purged, worst case is stale edge for remaining TTL.
  }
}
