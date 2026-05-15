import { Hono } from 'hono';
import { SITE_DOMAIN } from '../constants.ts';
import {
  getProject,
  createDomain,
  getDomainsByProjectId,
  getDomain,
  getDomainByHostname,
  updateDomainStatus,
  deleteDomain,
} from '../db.ts';
import type { ApiEnv } from '../env.ts';
import {
  createCustomHostname,
  getCustomHostname,
  deleteCustomHostname,
} from '../provisioning/cloudflare-api.ts';

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
    const cfHostname = await createCustomHostname(
      context.env.CF_ZONE_ID,
      context.env.CF_API_TOKEN,
      hostname,
    );

    // Insert domain record
    const domain = await createDomain(context.get('db'), projectId, hostname, cfHostname.id);

    return context.json({
      ...domain,
      cname_target: CNAME_TARGET,
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

    // If CF says active and DB says pending, update DB + write KV routing entry
    if (cfHostname.status === 'active' && domain.status === 'pending') {
      await updateDomainStatus(context.get('db'), domain.id, 'active');

      // Write KV routing entry for this domain
      const slugRouting = await context.env.ROUTING.get(project.slug);
      if (slugRouting) {
        await context.env.ROUTING.put(`domain:${domain.hostname}`, slugRouting);
      }
    }

    return context.json({
      ...domain,
      status: cfHostname.status === 'active' ? 'active' : domain.status,
      ssl_status: cfHostname.ssl.status,
      verification_errors: cfHostname.verification_errors,
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
