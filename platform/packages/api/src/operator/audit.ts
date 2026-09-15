import { count, desc, eq } from 'drizzle-orm';
import { Hono, type MiddlewareHandler } from 'hono';
import type { ApiEnv } from '../env.ts';
import { operatorEvents } from '../schema.ts';
import { dryRun, pagination, readBody } from './common.ts';

async function mutationSucceeded(response: Response) {
  if (!response.ok) {
    return false;
  }
  if (!response.headers.get('Content-Type')?.includes('application/json')) {
    return true;
  }
  try {
    const result: unknown = await response.clone().json();
    return !(
      typeof result === 'object' &&
      result !== null &&
      'ok' in result &&
      result.ok === false
    );
  } catch {
    return true;
  }
}

/** Persist intent before a mutation so an interrupted request stays observable. */
export const operatorAudit: MiddlewareHandler<ApiEnv> = async (context, next) => {
  if (context.req.method !== 'POST' || context.req.path.endsWith('/session/logout')) {
    return next();
  }
  const body = await readBody(context);
  if (dryRun(body)) {
    return next();
  }
  const id = crypto.randomUUID();
  const user = context.get('user');
  const db = context.get('db');
  const path = context.req.path.replace(/^\/operator\/v1\//, '');
  await db.insert(operatorEvents).values({
    id,
    user_id: user.id,
    login: user.login,
    action: path,
    target: path.split('/')[1] ?? '',
    status: 'pending',
  });
  await next();
  try {
    const succeeded = await mutationSucceeded(context.res);
    await db
      .update(operatorEvents)
      .set({
        status: succeeded ? 'success' : 'failed',
        http_status: context.res.status,
      })
      .where(eq(operatorEvents.id, id));
  } catch (error) {
    // The mutation may already have completed. Keep its response intact: the
    // durable pending entry signals an outcome requiring investigation.
    console.error('[operator] audit completion failed', id, error);
    context.header('X-Void-Audit-Status', 'pending');
  }
  context.header('X-Void-Audit-Id', id);
};

export const operatorAuditRoutes = new Hono<ApiEnv>();
operatorAuditRoutes.get('/system/events', async (context) => {
  const { page, limit, offset } = pagination(context);
  const db = context.get('db');
  const [events, totals] = await Promise.all([
    db
      .select()
      .from(operatorEvents)
      .orderBy(desc(operatorEvents.created_at), desc(operatorEvents.id))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(operatorEvents),
  ]);
  const total = totals[0]?.total ?? 0;
  return context.json({
    events,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  });
});
