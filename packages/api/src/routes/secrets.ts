import { Hono } from 'hono';
import {
  DEFAULT_DISPATCH_NAMESPACE,
  MAX_SECRET_NAME_LENGTH,
  MAX_SECRET_VALUE_BYTES,
} from '../constants';
import {
  deleteProjectSecret,
  getProject,
  listProjectSecretNames,
  upsertProjectSecret,
} from '../db';
import type { ApiEnv } from '../env';
import {
  deleteWorkerSecret,
  encryptProjectSecret,
  getVersionedWorkerName,
  putWorkerSecret,
} from '../project-secrets';

function isValidSecretName(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name);
}

const app = new Hono<ApiEnv>()

  .get('/:id/secrets', async (c) => {
    const projectId = c.req.param('id');
    const project = await getProject(c.get('db'), projectId);
    if (!project) {
      return c.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== c.get('user').id) {
      return c.json({ error: 'forbidden' }, 403);
    }

    return c.json(await listProjectSecretNames(c.get('db'), projectId));
  })

  .put('/:id/secrets/:name', async (c) => {
    const projectId = c.req.param('id');
    const secretName = c.req.param('name');
    if (!isValidSecretName(secretName)) {
      return c.json({ error: 'invalid secret name' }, 400);
    }
    if (secretName.length > MAX_SECRET_NAME_LENGTH) {
      return c.json({ error: 'secret name too long' }, 400);
    }

    const project = await getProject(c.get('db'), projectId);
    if (!project) {
      return c.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== c.get('user').id) {
      return c.json({ error: 'forbidden' }, 403);
    }

    let body: { value?: string } = {};
    try {
      body = await c.req.json<{ value?: string }>();
    } catch {
      body = {};
    }
    if (typeof body.value !== 'string' || body.value.length === 0) {
      return c.json({ error: 'value is required' }, 400);
    }
    if (new TextEncoder().encode(body.value).byteLength > MAX_SECRET_VALUE_BYTES) {
      return c.json({ error: 'secret value too large' }, 400);
    }

    const encrypted = await encryptProjectSecret(c.env, projectId, secretName, body.value);
    await upsertProjectSecret(
      c.get('db'),
      projectId,
      secretName,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.keyVersion,
    );

    if (project.active_deployment_id) {
      const dispatchNamespace = c.env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
      const workerName = getVersionedWorkerName(project.slug, project.active_deployment_id);
      try {
        await putWorkerSecret(c.env, dispatchNamespace, workerName, secretName, body.value);
      } catch (error) {
        return c.json(
          {
            error: 'secret stored but live propagation failed',
            name: secretName,
            liveUpdated: false,
            details: error instanceof Error ? error.message : String(error),
          },
          502,
        );
      }
    }

    return c.json({ ok: true, name: secretName });
  })

  .delete('/:id/secrets/:name', async (c) => {
    const projectId = c.req.param('id');
    const secretName = c.req.param('name');
    if (!isValidSecretName(secretName)) {
      return c.json({ error: 'invalid secret name' }, 400);
    }

    const project = await getProject(c.get('db'), projectId);
    if (!project) {
      return c.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== c.get('user').id) {
      return c.json({ error: 'forbidden' }, 403);
    }

    await deleteProjectSecret(c.get('db'), projectId, secretName);

    if (project.active_deployment_id) {
      const dispatchNamespace = c.env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
      const workerName = getVersionedWorkerName(project.slug, project.active_deployment_id);
      try {
        await deleteWorkerSecret(c.env, dispatchNamespace, workerName, secretName);
      } catch (error) {
        return c.json(
          {
            error: 'secret deleted from storage but live propagation failed',
            name: secretName,
            liveUpdated: false,
            details: error instanceof Error ? error.message : String(error),
          },
          502,
        );
      }
    }

    return c.json({ ok: true, name: secretName });
  });

export default app;
