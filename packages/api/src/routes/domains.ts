import { Hono } from 'hono';
import { SITE_DOMAIN } from '../constants';
import {
  getProject,
  createDomain,
  getDomainsByProjectId,
  getDomain,
  getDomainByHostname,
  updateDomainStatus,
  deleteDomain,
} from '../db';
import type { ApiEnv } from '../env';
import {
  createCustomHostname,
  getCustomHostname,
  deleteCustomHostname,
} from '../provisioning/cloudflare-api';

const CNAME_TARGET = `cname.${SITE_DOMAIN}`;

const app = new Hono<ApiEnv>()

  // Add a custom domain to a project
  .post('/:id/domains', async (c) => {
    const projectId = c.req.param('id');
    const project = await getProject(c.get('db'), projectId);
    if (!project) {
      return c.json({ error: 'project not found' }, 404);
    }

    if (project.user_id !== c.get('user').id) {
      return c.json({ error: 'forbidden' }, 403);
    }

    const { hostname } = await c.req.json<{ hostname: string }>();

    // Validate hostname format
    if (!hostname || typeof hostname !== 'string') {
      return c.json({ error: 'hostname is required' }, 400);
    }

    // Must be a valid domain (basic check)
    if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(hostname)) {
      return c.json({ error: 'invalid hostname format' }, 400);
    }

    // Cannot be a subdomain of the platform's app domain
    if (hostname.endsWith(`.${SITE_DOMAIN}`)) {
      return c.json({ error: `cannot use ${SITE_DOMAIN} subdomains` }, 400);
    }

    // Uniqueness check
    const existing = await getDomainByHostname(c.get('db'), hostname);
    if (existing) {
      return c.json({ error: 'hostname already in use' }, 409);
    }

    // Create custom hostname via CF API
    const cfHostname = await createCustomHostname(c.env.CF_ZONE_ID, c.env.CF_API_TOKEN, hostname);

    // Insert domain record
    const domain = await createDomain(c.get('db'), projectId, hostname, cfHostname.id);

    return c.json({
      ...domain,
      cname_target: CNAME_TARGET,
    });
  })

  // List domains for a project
  .get('/:id/domains', async (c) => {
    const projectId = c.req.param('id');
    const project = await getProject(c.get('db'), projectId);
    if (!project) {
      return c.json({ error: 'project not found' }, 404);
    }

    if (project.user_id !== c.get('user').id) {
      return c.json({ error: 'forbidden' }, 403);
    }

    const domains = await getDomainsByProjectId(c.get('db'), projectId);
    return c.json(domains);
  })

  // Get domain status (polls CF API for live status)
  .get('/:id/domains/:domainId', async (c) => {
    const projectId = c.req.param('id');
    const domainId = c.req.param('domainId');

    const project = await getProject(c.get('db'), projectId);
    if (!project) {
      return c.json({ error: 'project not found' }, 404);
    }

    if (project.user_id !== c.get('user').id) {
      return c.json({ error: 'forbidden' }, 403);
    }

    const domain = await getDomain(c.get('db'), domainId);
    if (!domain || domain.project_id !== projectId) {
      return c.json({ error: 'domain not found' }, 404);
    }

    // Poll CF API for live status
    const cfHostname = await getCustomHostname(
      c.env.CF_ZONE_ID,
      c.env.CF_API_TOKEN,
      domain.cf_hostname_id,
    );

    // If CF says active and DB says pending, update DB + write KV routing entry
    if (cfHostname.status === 'active' && domain.status === 'pending') {
      await updateDomainStatus(c.get('db'), domain.id, 'active');

      // Write KV routing entry for this domain
      const slugRouting = await c.env.ROUTING.get(project.slug);
      if (slugRouting) {
        await c.env.ROUTING.put(`domain:${domain.hostname}`, slugRouting);
      }
    }

    return c.json({
      ...domain,
      status: cfHostname.status === 'active' ? 'active' : domain.status,
      ssl_status: cfHostname.ssl.status,
      verification_errors: cfHostname.verification_errors,
    });
  })

  // Remove a custom domain
  .delete('/:id/domains/:domainId', async (c) => {
    const projectId = c.req.param('id');
    const domainId = c.req.param('domainId');

    const project = await getProject(c.get('db'), projectId);
    if (!project) {
      return c.json({ error: 'project not found' }, 404);
    }

    if (project.user_id !== c.get('user').id) {
      return c.json({ error: 'forbidden' }, 403);
    }

    const domain = await getDomain(c.get('db'), domainId);
    if (!domain || domain.project_id !== projectId) {
      return c.json({ error: 'domain not found' }, 404);
    }

    const warnings: string[] = [];

    // Best-effort CF + KV cleanup (always proceed to DB delete)
    await Promise.all([
      deleteCustomHostname(c.env.CF_ZONE_ID, c.env.CF_API_TOKEN, domain.cf_hostname_id).catch(
        (err) => {
          warnings.push(
            `Failed to delete custom hostname: ${err instanceof Error ? err.message : String(err)}`,
          );
        },
      ),
      c.env.ROUTING.delete(`domain:${domain.hostname}`).catch((err) => {
        warnings.push(
          `Failed to delete routing entry: ${err instanceof Error ? err.message : String(err)}`,
        );
      }),
    ]);

    // DB record is source of truth — always delete last
    await deleteDomain(c.get('db'), domain.id);

    return c.json({ ok: true, ...(warnings.length > 0 && { warnings }) });
  });

export default app;
