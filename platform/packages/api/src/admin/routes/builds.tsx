import { Hono } from 'hono';
import { isTerminalBuildStatus } from '../../build-status.ts';
import { getBuild } from '../../db.ts';
import type { ApiEnv } from '../../env.ts';
import { buildLogs } from '../../operator/build-operations.ts';
import { OperatorError } from '../../operator/common.ts';
import { renderFateDetailPage } from '../fate/render.ts';

const app = new Hono<ApiEnv>();

// GET /admin/builds/:id/logs?since=N
//
// Backs the live-tail poller in the admin build page. Reads the build row for
// its `executor` + `instance_type`, then:
//   - container builds: front the BuildManager DO's READ-ONLY `GET /logs?since=N`
//     (the DO that ran the build, chosen by `instance_type` via
//     `buildManagerNamespace` — free → BUILD_MANAGER, `standard-4` →
//     BUILD_MANAGER_LARGE). Relays the DO's `{ lines, lastSeq }` JSON verbatim.
//   - non-container (github_actions) builds: there is no DO log store; return an
//     empty page plus the external `logs_url` so the UI can link out. No DO call.
app.get('/:id/logs', async (context) => {
  const raw = Number(context.req.query('since'));
  const since = Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
  try {
    return context.json(
      await buildLogs(context.get('db'), context.env, context.req.param('id'), since),
    );
  } catch (error) {
    if (error instanceof OperatorError) {
      return context.json({ error: error.message }, error.status);
    }
    throw error;
  }
});

// GET /admin/builds/:id
//
// Build detail page: metadata + (for container builds) a live log panel whose
// React log panel polls the `/logs` endpoint above. github_actions builds get a
// link out to their GitHub Actions run instead, since their logs live there.
//
// `?status=1` returns a tiny JSON `{ status, terminal }` probe used by the
// log-panel poller to decide when to stop polling — it does NOT touch the DO
// or the Task-3 logs endpoint.
app.get('/:id', async (context) => {
  if (context.req.query('status') === undefined) {
    return renderFateDetailPage(context, 'buildDetail');
  }
  const build = await getBuild(context.get('db'), context.req.param('id'));
  if (!build) {
    return context.json({ error: 'build not found' }, 404);
  }
  return context.json({ status: build.status, terminal: isTerminalBuildStatus(build.status) });
});

export default app;
