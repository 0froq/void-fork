import { Hono } from 'hono';
import { SITE_DOMAIN } from '../constants.ts';
import {
  getProject,
  createDomain,
  getDomainsByProjectId,
  getDomain,
  getDomainByHostname,
  deleteDomain,
} from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { tryActivateDomain } from '../provisioning/activate-domain.ts';
import {
  CloudflareApiError,
  createCustomHostname,
  deleteCustomHostname,
} from '../provisioning/cloudflare-api.ts';
import type { DomainVerificationData } from '../schema.ts';

const CNAME_TARGET = `cname.${SITE_DOMAIN}`;

// Whitelist of CF status codes the create-hostname route surfaces to the
// caller. See the catch block on `createCustomHostname` for the full
// rationale on why 401/403/404 are NOT in this set.
const CF_PASSTHROUGH_STATUSES = new Set<number>([400, 409, 422, 429]);

const app = new Hono<ApiEnv>()

  // Add a custom domain to a project
  .post('/:id/domains', async (context) => {
    const projectId = context.req.param('id');
    const project = await getProject(context.get('db'), projectId);
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }

    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }

    const { hostname } = await context.req.json<{ hostname: string }>();

    // Validate hostname format
    if (!hostname || typeof hostname !== 'string') {
      return context.json({ error: 'hostname is required' }, 400);
    }

    // Must be a valid domain (basic check)
    if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(hostname)) {
      return context.json({ error: 'invalid hostname format' }, 400);
    }

    // Cannot be a subdomain of the platform's app domain
    if (hostname.endsWith(`.${SITE_DOMAIN}`)) {
      return context.json({ error: `cannot use ${SITE_DOMAIN} subdomains` }, 400);
    }

    // Uniqueness check
    const existing = await getDomainByHostname(context.get('db'), hostname);
    if (existing) {
      return context.json({ error: 'hostname already in use' }, 409);
    }

    // Create custom hostname via CF API. CF's 4xx responses are not all
    // semantically equivalent and only a subset can be safely surfaced to
    // the caller:
    //
    //   400 — hostname validation (reserved TLDs, malformed names): caller-fixable
    //   409 — hostname already registered to another account: caller-fixable
    //   422 — other validation: caller-fixable
    //   429 — CF rate limit: transient; caller should back off (retry-after)
    //
    // 401 and 403 BOTH commonly indicate our `CF_API_TOKEN` is broken or
    // under-scoped — a server-config fault the caller can't act on, and
    // whose CF message ("Authentication error", "permission denied", etc.)
    // would leak internal state if surfaced. 403 is also returned for some
    // caller-fixable cases (SaaS zone-apex collision), but the HTTP status
    // alone can't disambiguate — discriminating would need CF's internal
    // error code (`errors[].code`), which `CloudflareApiError` does not
    // currently preserve. Until it does, the conservative choice is to
    // treat 403 like 401 and re-throw → onError → generic 500.
    //
    // Same for 404 (could be zone-not-found = misconfig) and any other
    // status not in the whitelist. CF 5xx (upstream degraded) also re-throws.
    //
    // The CF hostname has not been created when this catch fires, so there
    // is no orphan to clean up.
    let cfHostname;
    try {
      cfHostname = await createCustomHostname(
        context.env.CF_ZONE_ID,
        context.env.CF_API_TOKEN,
        hostname,
      );
    } catch (err) {
      if (err instanceof CloudflareApiError && CF_PASSTHROUGH_STATUSES.has(err.status)) {
        return context.json({ error: err.message }, err.status as 400 | 409 | 422 | 429);
      }
      throw err;
    }

    // Under HTTP-DCV the certificate is validated at CF's edge once the
    // hostname proxies through it, so CF never emits `ssl.validation_records`
    // (no `_acme-challenge` TXT). `ownership_verification` — the
    // `_cf-custom-hostname` TXT that proves the user controls the hostname —
    // IS returned synchronously in the create response, so persist it
    // straight away and return. (`ssl_validation_records` will be
    // empty/absent — expected.)
    const verificationData: DomainVerificationData = {
      ownership_verification: cfHostname.ownership_verification,
      ssl_validation_records: cfHostname.ssl.validation_records,
    };

    // Insert domain record
    const domain = await createDomain(
      context.get('db'),
      projectId,
      hostname,
      cfHostname.id,
      verificationData,
    );

    return context.json({
      ...domain,
      cname_target: CNAME_TARGET,
      ownership_verification: cfHostname.ownership_verification,
      ssl_validation_records: cfHostname.ssl.validation_records ?? [],
    });
  })

  // List domains for a project
  .get('/:id/domains', async (context) => {
    const projectId = context.req.param('id');
    const project = await getProject(context.get('db'), projectId);
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }

    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }

    const domains = await getDomainsByProjectId(context.get('db'), projectId);
    return context.json(domains);
  })

  // Get domain status (polls CF API for live status)
  .get('/:id/domains/:domainId', async (context) => {
    const projectId = context.req.param('id');
    const domainId = context.req.param('domainId');

    const project = await getProject(context.get('db'), projectId);
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }

    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }

    const domain = await getDomain(context.get('db'), domainId);
    if (!domain || domain.project_id !== projectId) {
      return context.json({ error: 'domain not found' }, 404);
    }

    const { cf, activated, awaitingDeployment } = await tryActivateDomain(
      context.env,
      context.get('db'),
      domain,
      project,
    );

    return context.json({
      ...domain,
      status: activated || domain.status === 'active' ? 'active' : domain.status,
      cname_target: CNAME_TARGET,
      ssl_status: cf.ssl.status,
      cf_status: cf.status,
      awaiting_deployment: awaitingDeployment,
      verification_errors: cf.verification_errors,
      ownership_verification: cf.ownership_verification,
      ssl_validation_records: cf.ssl.validation_records ?? [],
    });
  })

  // Remove a custom domain
  .delete('/:id/domains/:domainId', async (context) => {
    const projectId = context.req.param('id');
    const domainId = context.req.param('domainId');

    const project = await getProject(context.get('db'), projectId);
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }

    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }

    const domain = await getDomain(context.get('db'), domainId);
    if (!domain || domain.project_id !== projectId) {
      return context.json({ error: 'domain not found' }, 404);
    }

    const warnings: Array<string> = [];

    // Best-effort CF + KV cleanup (always proceed to DB delete)
    await Promise.all([
      deleteCustomHostname(
        context.env.CF_ZONE_ID,
        context.env.CF_API_TOKEN,
        domain.cf_hostname_id,
      ).catch((err) => {
        warnings.push(
          `Failed to delete custom hostname: ${err instanceof Error ? err.message : String(err)}`,
        );
      }),
      context.env.ROUTING.delete(`domain:${domain.hostname}`).catch((err) => {
        warnings.push(
          `Failed to delete routing entry: ${err instanceof Error ? err.message : String(err)}`,
        );
      }),
    ]);

    // DB record is source of truth — always delete last
    await deleteDomain(context.get('db'), domain.id);

    return context.json({ ok: true, ...(warnings.length > 0 && { warnings }) });
  });

export default app;
