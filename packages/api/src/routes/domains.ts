import { Hono } from 'hono';
import { SITE_DOMAIN } from '../constants.ts';
import {
  getProject,
  createDomain,
  getDomainsByProjectId,
  getDomain,
  getDomainByHostname,
  updateDomainStatus,
  updateDomainVerificationData,
  deleteDomain,
} from '../db.ts';
import type { ApiEnv } from '../env.ts';
import {
  createCustomHostname,
  getCustomHostname,
  deleteCustomHostname,
  pollCustomHostnameUntilSslRecords,
} from '../provisioning/cloudflare-api.ts';
import type { DomainVerificationData } from '../schema.ts';

const CNAME_TARGET = `cname.${SITE_DOMAIN}`;

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

    // Create custom hostname via CF API
    let cfHostname = await createCustomHostname(
      context.env.CF_ZONE_ID,
      context.env.CF_API_TOKEN,
      hostname,
    );

    // CF populates `ssl.validation_records` asynchronously; poll briefly so the
    // create response includes them. See helper for the full rationale.
    if (
      (cfHostname.ssl.validation_records ?? []).length === 0 &&
      cfHostname.ssl.status !== 'active'
    ) {
      const deadlineOverride = context.env.CF_HOSTNAME_POLL_DEADLINE_MS;
      const deadlineMs =
        typeof deadlineOverride === 'number' &&
        Number.isFinite(deadlineOverride) &&
        deadlineOverride > 0
          ? deadlineOverride
          : 8_000;
      const intervalOverride = context.env.CF_HOSTNAME_POLL_INITIAL_INTERVAL_MS;
      const initialIntervalMs =
        typeof intervalOverride === 'number' &&
        Number.isFinite(intervalOverride) &&
        intervalOverride > 0
          ? intervalOverride
          : 500;
      try {
        cfHostname = await pollCustomHostnameUntilSslRecords(
          context.env.CF_ZONE_ID,
          context.env.CF_API_TOKEN,
          cfHostname.id,
          { deadlineMs, initialIntervalMs },
        );
      } catch (err) {
        // Don't orphan the CF hostname on a transient 5xx mid-poll — the
        // hostname is already created but the DB row hasn't been inserted
        // yet. Fall through with the original create response; the user
        // (or `void domain status`) will surface the SSL records on the
        // next poll.
        console.warn(
          `CF API error while polling for SSL records for ${hostname}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      if ((cfHostname.ssl.validation_records ?? []).length === 0) {
        console.warn(`SSL validation records did not appear for ${hostname} within deadline`);
      }
    }

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

    // Poll CF API for live status
    const cfHostname = await getCustomHostname(
      context.env.CF_ZONE_ID,
      context.env.CF_API_TOKEN,
      domain.cf_hostname_id,
    );

    // CF only flips status to `active` after BOTH ownership verification and
    // SSL DV complete, so `status === 'active'` is itself the verified signal.
    // Also require `ssl.status === 'active'` per CF for SaaS docs, which call
    // this out as the production-traffic precondition. Require `ssl.method`
    // to be `txt` so legacy HTTP-DCV hostnames — vulnerable to the wildcard
    // CNAME hijack this change closes — cannot be activated by a poll.
    const gateOk =
      cfHostname.status === 'active' &&
      cfHostname.ssl.status === 'active' &&
      cfHostname.ssl.method === 'txt';

    // Only activate after KV routing is in place. If the project has never
    // been deployed, `project.slug` is absent from KV; leaving the DB row in
    // 'pending' ensures the next poll retries (a future deploy populates the
    // slug entry). Flipping DB→active before writing KV would leave traffic
    // 404ing forever, since `domain.status === 'pending'` would no longer
    // fire on subsequent polls.
    let routingWritten = false;
    // Read slug routing whenever the CF gate is satisfied so we can surface
    // `awaiting_deployment` to the caller regardless of whether activation
    // actually happened (activation also requires `domain.status === 'pending'`).
    const slugRouting =
      gateOk && domain.status === 'pending' ? await context.env.ROUTING.get(project.slug) : null;
    if (gateOk && domain.status === 'pending' && slugRouting) {
      await context.env.ROUTING.put(`domain:${domain.hostname}`, slugRouting);
      await updateDomainStatus(context.get('db'), domain.id, 'active');
      routingWritten = true;
    }
    const awaitingDeployment = gateOk && domain.status === 'pending' && !slugRouting;

    if (cfHostname.ownership_verification || cfHostname.ssl.validation_records) {
      const verificationData: DomainVerificationData = {
        ownership_verification: cfHostname.ownership_verification,
        ssl_validation_records: cfHostname.ssl.validation_records,
      };
      await updateDomainVerificationData(context.get('db'), domain.id, verificationData);
      domain.verification_data = verificationData;
    }

    return context.json({
      ...domain,
      status: routingWritten || domain.status === 'active' ? 'active' : domain.status,
      ssl_status: cfHostname.ssl.status,
      cf_status: cfHostname.status,
      awaiting_deployment: awaitingDeployment,
      verification_errors: cfHostname.verification_errors,
      ownership_verification: cfHostname.ownership_verification,
      ssl_validation_records: cfHostname.ssl.validation_records ?? [],
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
