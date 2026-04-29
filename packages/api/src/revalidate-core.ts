import {
  denormalizeIsrPath,
  isrCacheKey,
  isrCachePrefix,
  isrCacheVariantPrefix,
  isrEdgeCacheUrl,
  isrEdgeCacheUrlForToken,
  splitIsrCacheKey,
} from '@voidcloud/isr-shared';
import type { Context } from 'hono';
import { R2_CONCURRENCY, uploadPool } from './concurrency.ts';
import { SITE_DOMAIN } from './constants.ts';
import { getDomainsByProjectId } from './db.ts';
import type { ApiEnv } from './env.ts';
import { resolveCurrentIsrDeployments, type IsrRoutingTarget } from './isr-cache.ts';
import { purgeZoneCache } from './provisioning/cloudflare-api.ts';

interface RevalidateProject {
  slug: string;
  active_deployment_id: string | null;
}

interface RevalidateRequestBody {
  paths?: Array<string>;
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

  const targets: Array<IsrRoutingTarget> = [
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
    // Edge purge fans out to `|hostnames| × |ids| × (2·|pathnames| + 2·|variantTuples|)`
    // URL strings. For high-cardinality projects (tens of thousands of paths,
    // dozens of variants each, multiple hostnames/ids) that array can pin
    // hundreds of MB and OOM the Worker. Flush per KV list page instead so
    // peak memory is bounded by a single page (~1000 keys). CF tolerates
    // duplicate purge URLs across calls, so cross-page dedup loss is fine.
    const pathnameSet = new Set<string>();

    for (const deploymentId of union) {
      const prefix = isrCachePrefix(projectId, deploymentId);
      let cursor: string | undefined;

      do {
        const listed = await c.env.ISR_CACHE.list({ prefix, cursor });
        if (listed.keys.length > 0) {
          // Per-page accumulators: dedup pathnames within a page, allow
          // duplicates across pages (CF tolerates them).
          const pageBatchPathnames = new Set<string>();
          const pageBatchVariants: Array<PurgeVariantTuple> = [];
          for (const key of listed.keys) {
            const tail = key.name.slice(prefix.length);
            const split = splitIsrCacheKey(tail);
            const pathname = denormalizeIsrPath(split.normalizedPath);
            pathnameSet.add(pathname);
            pageBatchPathnames.add(pathname);
            if (split.variantToken) {
              pageBatchVariants.push({ pathname, variantToken: split.variantToken });
            }
          }
          await uploadPool(listed.keys, R2_CONCURRENCY, (key) => c.env.ISR_CACHE.delete(key.name));
          await purgeEdgeCache(c, perHostname, Array.from(pageBatchPathnames), pageBatchVariants);
        }
        cursor = listed.list_complete ? undefined : listed.cursor;
      } while (cursor);
    }

    // `purged` = unique pathnames purged (mirrors what the caller asked for,
    // not the raw count of KV keys deleted across all deployment namespaces).
    return c.json({ purged: pathnameSet.size });
  }

  if (!body.paths || !Array.isArray(body.paths) || body.paths.length === 0) {
    return c.json({ error: 'provide `paths` array or `all: true`' }, 400);
  }

  // Purge specific paths across every deployment namespace. Each path may
  // have a direct-hit key plus one or more `#rw=<token>` variant keys
  // (requests served via dispatch rewrite); delete every variant and
  // collect the original URLs so the edge cache can be purged too.
  const variantTuples: Array<PurgeVariantTuple> = [];
  for (const deploymentId of union) {
    for (const path of body.paths) {
      await c.env.ISR_CACHE.delete(isrCacheKey(projectId, deploymentId, path));

      const variantPrefix = isrCacheVariantPrefix(projectId, deploymentId, path);
      let cursor: string | undefined;
      do {
        const listed = await c.env.ISR_CACHE.list({ prefix: variantPrefix, cursor });
        if (listed.keys.length > 0) {
          for (const key of listed.keys) {
            const tail = key.name.slice(isrCachePrefix(projectId, deploymentId).length);
            const split = splitIsrCacheKey(tail);
            if (split.variantToken) {
              variantTuples.push({ pathname: path, variantToken: split.variantToken });
            }
          }
          await uploadPool(listed.keys, R2_CONCURRENCY, (key) => c.env.ISR_CACHE.delete(key.name));
        }
        cursor = listed.list_complete ? undefined : listed.cursor;
      } while (cursor);
    }
  }

  await purgeEdgeCache(c, perHostname, body.paths, variantTuples);
  // `purged` = unique path entries the caller asked for. The cross-namespace
  // KV deletes above are an implementation detail of the drift-handling hedge.
  return c.json({ purged: body.paths.length });
}

interface PurgeVariantTuple {
  pathname: string;
  /**
   * Pre-hashed variant token from the KV key. The original URL is not
   * recoverable post-hash; we only need the token to rebuild the matching
   * `__void_orig=<token>` edge cache URL via `isrEdgeCacheUrlForToken`.
   */
  variantToken: string;
}

async function purgeEdgeCache(
  c: Context<ApiEnv>,
  perHostname: Map<string, Set<string>>,
  pathnames: Array<string>,
  variantTuples: Array<PurgeVariantTuple> = [],
): Promise<void> {
  if ((pathnames.length === 0 && variantTuples.length === 0) || perHostname.size === 0) {
    return;
  }

  try {
    const urls: Array<string> = [];
    for (const [hostname, ids] of perHostname) {
      for (const id of ids) {
        for (const pathname of pathnames) {
          urls.push(isrEdgeCacheUrl(hostname, pathname, id, 'html'));
          urls.push(isrEdgeCacheUrl(hostname, pathname, id, 'json'));
        }
        for (const tuple of variantTuples) {
          urls.push(
            isrEdgeCacheUrlForToken(hostname, tuple.pathname, id, 'html', tuple.variantToken),
          );
          urls.push(
            isrEdgeCacheUrlForToken(hostname, tuple.pathname, id, 'json', tuple.variantToken),
          );
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
