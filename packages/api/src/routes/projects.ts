import { sql as drizzleSql } from 'drizzle-orm';
import { Hono } from 'hono';
import { hmacSignState } from '../auth/hmac.ts';
import { DEFAULT_DISPATCH_NAMESPACE } from '../constants.ts';
import { clearCronScheduler, syncCronScheduler } from '../cron-scheduler-client.ts';
import type { Db } from '../db.ts';
import {
  createProject,
  getProject,
  getProjectBySlug,
  getProjectsByUserId,
  getLatestDeploymentsByProjectIds,
  getProjectDeployments,
  getProjectResources,
  getDomainsByProjectId,
  getDomainsByProjectIds,
  getDeployment,
  cancelDeployment,
  setActiveDeployment,
  appendAppliedMigrations,
  appendProjectMigrations,
  activeDeploymentContainsMigration,
  getProjectMigrationRows,
  getProjectMigrationNames,
  renameAppliedMigrationsForProject,
  renameProjectMigrations,
  recordMigrationRenames,
  migrationRenameExists,
  invalidateMigrationRenamesForOldName,
  upsertProjectDatabaseUrl,
  getProjectDatabaseUrl,
  updateProjectType,
  markRoutingUnpublished,
  publishRoutingIfStillActive,
} from '../db.ts';
import { type ApiEnv, isDevBypass } from '../env.ts';
import { validateSubmittedExecutionPlans } from '../migrations/execution-plan.ts';
import { ensureTrackingTable, queryD1, runRemoteMigrations } from '../migrations/remote-runner.ts';
import { getProjectDeploymentWorkerName, getProjectQueueName } from '../naming.ts';
import { encryptProjectSecret, decryptProjectSecret } from '../project-secrets.ts';
import {
  CloudflareApiError,
  InvalidHyperdriveConnectionStringError,
  getDispatchWorkerProxyToken,
} from '../provisioning/cloudflare-api.ts';
import {
  applyCurrentSuspension,
  buildRoutingJson,
  buildStaticRoutingJson,
  sweepStaleQueueRoutes,
  writeProjectAccountEntry,
} from '../routing.ts';
import { tokenizeSql } from '../sql/tokenize.ts';
import { getPlanLimits } from '../tiers.ts';
import type { DeployManifest, Project } from '../types.ts';
import { getRequestsDataset, queryProjectRequestOverview } from './usage.ts';

export const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'billing',
  'blog',
  'cdn',
  'cname',
  'dash',
  'dashboard',
  'docs',
  'ftp',
  'gateway',
  'help',
  'imap',
  'login',
  'mail',
  'ns1',
  'ns2',
  'ns3',
  'ns4',
  'oauth',
  'pop',
  'proxy',
  'register',
  'signup',
  'smtp',
  'sso',
  'staging',
  'static',
  'status',
  'support',
  'www',
]);

const DESTRUCTIVE_PATTERNS = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+VIEW\b/i,
  /\bDROP\s+INDEX\b/i,
  /\bDROP\s+TRIGGER\b/i,
  /\bDROP\s+COLUMN\b/i,
  // Match all three destructive RENAME forms SQLite accepts: `RENAME TO …`
  // (table rename), `RENAME COLUMN …` (column rename), and the legacy
  // naked-column form `RENAME <old_col> TO <new_col>` (no `COLUMN` keyword).
  // The `[^;\s]+\s+TO\b` branch covers the legacy form — any non-whitespace
  // non-semicolon token stands in for the old column name; because the
  // tokenizer replaces quoted identifiers with `"_"` / `` `_` `` / `[_]`,
  // quoted forms match the same pattern. `[^;]` on both lookaheads guards
  // against crossing a statement boundary. The legacy form is rare in
  // drizzle/modern SQL but still accepted by the engine, so skipping it
  // leaves a bypass. False positives on benign additive migrations like
  // `ALTER TABLE x ADD COLUMN rename TEXT` are avoided because the legacy
  // branch requires a following `TO` keyword — a trailing column-type
  // token never matches.
  /\bALTER\s+TABLE\b[^;]*?\bRENAME\s+(?:TO\b|COLUMN\b|[^;\s]+\s+TO\b)/i,
  /\bTRUNCATE\b/i,
  // Destructive DML forms requiring the same pragma opt-in as DDL:
  // `INSERT OR REPLACE INTO …` silently deletes any row whose primary key
  // collides with the insert, dressed up as an insert. Unbounded DELETE and
  // UPDATE checks are statement-aware below so a later statement or nested
  // subquery WHERE cannot mask an unbounded write.
  /\bINSERT\s+OR\s+REPLACE\b/i,
];

const DESTRUCTIVE_PRAGMA = '-- void:allow-destructive';

/**
 * Sentinel error used by the /rollback handler to signal an HTTP
 * response status from inside the advisory-locked tx callback.
 * `db.transaction` rolls back on any throw, so we use this wrapper to
 * distinguish "user-facing 404/400" from unexpected exceptions that
 * should surface as 500. Handling is local to the /rollback handler.
 */
class RollbackError extends Error {
  constructor(
    public readonly status: 400 | 404,
    message: string,
    /**
     * For destructive-rollback rejections, we surface the server-computed
     * diff as a structured field alongside the error string so
     * programmatic callers (CLI retry, dashboard, MCP agent) can echo it
     * back verbatim without re-parsing the human message. Migration names
     * can contain arbitrary characters (see /rename which accepts any
     * non-empty string), so human-readable hints built via string
     * concatenation are not safe to copy-paste.
     */
    public readonly destructiveMigrations?: ReadonlyArray<string>,
  ) {
    super(message);
    this.name = 'RollbackError';
  }
}

type ProjectListItem = Awaited<ReturnType<typeof getProjectsByUserId>>[number] & {
  custom_domain: string | null;
  latest_deployment: Awaited<ReturnType<typeof getLatestDeploymentsByProjectIds>> extends Map<
    string,
    infer Deployment
  >
    ? Deployment | null
    : null;
  traffic: {
    requests5m: number;
    lastSeenAt: string | null;
    sparkline5m: ReadonlyArray<number>;
  };
  health: {
    responses4xx15m: number;
    responses5xx15m: number;
    errorRate5xx15m: number;
  };
};

function deployAttentionScore(status: string | null | undefined): number {
  if (status === 'failed') {
    return 4;
  }
  if (
    status === 'pending' ||
    status === 'uploading' ||
    status === 'migrating' ||
    status === 'prerendering' ||
    status === 'canceling'
  ) {
    return 3;
  }
  if (status === 'canceled') {
    return 1;
  }
  return 0;
}

function projectListSortScore(project: ProjectListItem): number {
  const hasRecentErrors = project.health.responses5xx15m > 0 ? 2 : 0;
  return Math.max(deployAttentionScore(project.latest_deployment?.status), hasRecentErrors);
}

function parseSortDate(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

function sortProjectList(a: ProjectListItem, b: ProjectListItem): number {
  const attentionDelta = projectListSortScore(b) - projectListSortScore(a);
  if (attentionDelta !== 0) {
    return attentionDelta;
  }

  const deployDelta =
    parseSortDate(b.latest_deployment?.created_at) - parseSortDate(a.latest_deployment?.created_at);
  if (deployDelta !== 0) {
    return deployDelta;
  }

  const trafficDelta = b.traffic.requests5m - a.traffic.requests5m;
  if (trafficDelta !== 0) {
    return trafficDelta;
  }

  return a.slug.localeCompare(b.slug);
}

/**
 * D1 returns "no such table" when a table is missing. GET /:id/migrations
 * probes both `_void_migrations` and `_migrations` and must tolerate either
 * being absent, but must NOT silently swallow unrelated errors (auth failure,
 * timeout, quota, "database is locked", etc.) — those should surface to the
 * caller instead of returning an empty applied set.
 */
/**
 * Resolve the proxy token to use when re-targeting routing/cron at a
 * historical deployment.
 *
 * Preferred path: fetch the EXACT `__VOID_PROXY_TOKEN` plain_text
 * binding baked into the target worker. Rotating `JWT_SECRET` after
 * that worker was deployed would make a fresh `hmacSignState` value
 * mismatch the worker and 401 every /__void/queue and /__void/scheduled
 * relay.
 *
 * Legacy workers (deployed before the binding was introduced) report
 * `{kind: "missing"}`. Falling back to the current-secret derivation is
 * safe only if `JWT_SECRET` has not rotated since the worker was
 * deployed; the warning surfaces the risk to operators so they can
 * redeploy instead of relying on the fallback.
 *
 * Transient CF API failures MUST propagate. A silent null that becomes
 * a fallback can write a mismatched token into KV that will 401 the
 * worker indefinitely.
 */
async function resolveRollbackProxyToken(
  env: ApiEnv['Bindings'],
  workerName: string,
  projectId: string,
): Promise<string> {
  const dispatchNamespace = env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
  const lookup = await getDispatchWorkerProxyToken(
    env.CF_ACCOUNT_ID,
    env.CF_API_TOKEN,
    dispatchNamespace,
    workerName,
  );
  if (lookup.kind === 'found') {
    return lookup.token;
  }
  if (lookup.kind === 'error') {
    throw new Error(
      `rollback: could not read __VOID_PROXY_TOKEN from worker "${workerName}": ${lookup.error.message}`,
    );
  }
  // lookup.kind === 'missing' — legacy worker.
  console.warn(
    `[rollback] worker "${workerName}" has no __VOID_PROXY_TOKEN binding; falling back to current-secret derivation. If JWT_SECRET has rotated since this deployment was live, you must redeploy the project instead.`,
  );
  return hmacSignState(projectId, env.JWT_SECRET);
}

function isMissingTableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no such table/i.test(msg);
}

type LineComment = Readonly<{
  text: string;
  standalone: boolean;
}>;

/**
 * Tokenize SQL into executable code and the set of line-comment lines.
 * String literals, identifier quotes, and block comments are stripped from
 * `code`; only `-- ...` line comments are accumulated into `lineComments`,
 * each tagged with whether it stood alone on its raw source line.
 *
 * This is load-bearing for four reasons:
 *
 *   1. A raw `sql.includes('-- void:allow-destructive')` check authorizes
 *      destructive SQL when the pragma appears anywhere in the file,
 *      including inside a string literal. A migration like
 *      `INSERT INTO t VALUES('-- void:allow-destructive'); DROP TABLE users;`
 *      would slip through — the pragma must only be honored when it is
 *      actually a SQL comment.
 *   2. Running destructive-pattern regexes on the raw SQL false-positives
 *      on data like `VALUES('DROP TABLE users')` and on `-- DROP TABLE`
 *      in a line comment, which could block legitimate migrations.
 *   3. Block comments are intentionally NOT counted toward the pragma. A
 *      docstring like `/* use -- void:allow-destructive to permit drops *​/`
 *      is documentation, not authorization. They are also replaced with a
 *      single space rather than deleted outright so that token boundaries
 *      are preserved — `DROP/**​/TABLE` must not collapse to `DROPTABLE`,
 *      which would slip the destructive keyword regex entirely.
 *   4. The standalone bit on each line comment lets the caller require
 *      that the destructive pragma occupies its own raw line. Trailing
 *      pragmas like `CREATE TABLE t(id); -- void:allow-destructive`
 *      must not retroactively authorize a later DROP TABLE.
 *
 * Only the SQLite lexical forms are handled: `'...'` strings with `''`
 * escape, `"..."` / `` `...` `` / `[...]` identifier quotes with doubled
 * closing-quote escape, `-- line` comments, and `/* block *​/` comments.
 */
function stripSqlStringsAndComments(sql: string): {
  code: string;
  lineComments: ReadonlyArray<LineComment>;
} {
  let code = '';
  const lineComments: Array<LineComment> = [];

  for (const seg of tokenizeSql(sql)) {
    switch (seg.kind) {
      case 'sql':
        code += sql.slice(seg.start, seg.end);
        break;
      case 'line-comment': {
        // Walk backwards from the `--` to the previous newline (or start of
        // input). The comment is "standalone" iff every character in that
        // raw-source prefix is whitespace — anything else (a SQL token, the
        // closing `*​/` of a block comment, a string literal, etc.) means the
        // pragma is sharing its line with content and must not authorize.
        let standalone = true;
        for (let k = seg.start - 1; k >= 0; k--) {
          const ch = sql[k];
          if (ch === '\n') {
            break;
          }
          if (ch !== ' ' && ch !== '\t' && ch !== '\r') {
            standalone = false;
            break;
          }
        }
        // Capture the line comment text without the trailing newline so
        // callers can compare exact directive forms.
        lineComments.push({ text: sql.slice(seg.start, seg.end), standalone });
        break;
      }
      case 'block-comment':
        // Replace the block comment with a single space so token boundaries
        // are preserved — `DROP/**​/TABLE` must NOT collapse to `DROPTABLE`,
        // which would slip past the destructive regex entirely. The space
        // is sufficient because every destructive pattern requires `\b` /
        // `\s+` between keywords.
        code += ' ';
        break;
      case 'string':
        code += "''";
        break;
      case 'ident-quote': {
        // Replace the quoted identifier body with a neutral placeholder `_`
        // rather than copying the raw slice. Two bypasses hinge on this:
        //
        //   1. A semicolon inside an identifier — `ALTER TABLE "user;data"
        //      RENAME TO x` — would survive into the code stream and
        //      truncate the `[^;]*?` lookahead in the destructive ALTER
        //      RENAME regex, stopping the match at the `;` before `RENAME`
        //      and letting the destructive DDL through unauthorized.
        //   2. A destructive keyword inside an identifier — `CREATE TABLE
        //      "DROP TABLE users" (x INT)` — would false-positive against
        //      the `/\bDROP\s+TABLE\b/` regex and block a benign migration.
        //
        // The placeholder keeps the opening and closing quote characters so
        // token boundaries (`ALTER TABLE "foo" RENAME` → four tokens)
        // remain intact, but the body is fixed to `_` which cannot contain
        // semicolons or destructive keywords.
        const close = seg.open === '[' ? ']' : seg.open;
        code += seg.open + '_' + close;
        break;
      }
    }
  }

  return { code, lineComments };
}

function splitExecutableStatements(sql: string): Array<string> {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function hasTopLevelKeyword(statement: string, keyword: string): boolean {
  let depth = 0;
  for (let index = 0; index < statement.length; index++) {
    const character = statement[index];
    if (character === '(') {
      depth++;
      continue;
    }
    if (character === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    if (
      statement.slice(index, index + keyword.length).toUpperCase() === keyword &&
      !/[A-Z0-9_]/i.test(statement[index - 1] ?? '') &&
      !/[A-Z0-9_]/i.test(statement[index + keyword.length] ?? '')
    ) {
      return true;
    }
  }
  return false;
}

function hasUnboundedWrite(statement: string): boolean {
  if (/\bDELETE\s+FROM\b/i.test(statement)) {
    return !hasTopLevelKeyword(statement, 'WHERE');
  }
  if (/\bUPDATE\b[\s\S]*\bSET\b/i.test(statement)) {
    return !hasTopLevelKeyword(statement, 'WHERE');
  }
  return false;
}

function hasUnauthorizedDestructive(
  migrations: ReadonlyArray<{ name: string; sql: string }>,
): ReadonlyArray<string> {
  const violations: Array<string> = [];
  for (const m of migrations) {
    const { code, lineComments } = stripSqlStringsAndComments(m.sql);
    const isDestructive = splitExecutableStatements(code).some((statement) => {
      return (
        DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(statement)) ||
        hasUnboundedWrite(statement)
      );
    });
    if (!isDestructive) {
      continue;
    }
    // The pragma is only honored when it appears as a standalone line-comment
    // directive: it must be the sole content of its raw source line (only
    // whitespace before the `--`), and the comment body — after the `--` and
    // surrounding whitespace — must be exactly `void:allow-destructive`. A
    // trailing pragma like `CREATE TABLE t(id); -- void:allow-destructive`
    // does not authorize, and neither does a documentation comment like
    // `-- see void:allow-destructive for details`.
    const authorized = lineComments.some(
      (line) => line.standalone && line.text.trim() === DESTRUCTIVE_PRAGMA,
    );
    if (!authorized) {
      violations.push(m.name);
    }
  }
  return violations;
}

const app = new Hono<ApiEnv>()

  // List all projects for the current user
  .get('/', async (context) => {
    const userId = context.get('user').id;
    const projects = await getProjectsByUserId(context.get('db'), userId);

    // Batch-fetch domains for all projects in a single query
    const projectIds = projects.map((p) => p.id);
    const [domainMap, latestDeployments, requestOverview] =
      projectIds.length > 0
        ? await Promise.all([
            getDomainsByProjectIds(context.get('db'), projectIds),
            getLatestDeploymentsByProjectIds(context.get('db'), projectIds),
            isDevBypass(context.env)
              ? Promise.resolve(new Map())
              : queryProjectRequestOverview(
                  context.env.CF_ACCOUNT_ID,
                  context.env.CF_API_TOKEN,
                  getRequestsDataset(context.env),
                  projectIds,
                ),
          ])
        : [new Map(), new Map(), new Map()];

    const projectsWithSummaries = projects.map((p): ProjectListItem => {
      const pDomains = domainMap.get(p.id);
      const domain =
        pDomains?.find((d: { status: string }) => d.status === 'active') ?? pDomains?.[0];
      const overview = requestOverview.get(p.id);
      return {
        ...p,
        custom_domain: domain?.hostname ?? null,
        latest_deployment: latestDeployments.get(p.id) ?? null,
        traffic: {
          requests5m: overview?.requests5m ?? 0,
          lastSeenAt: overview?.lastSeenAt ?? null,
          sparkline5m: overview?.sparkline5m ?? Array.from({ length: 20 }, () => 0),
        },
        health: {
          responses4xx15m: overview?.responses4xx15m ?? 0,
          responses5xx15m: overview?.responses5xx15m ?? 0,
          errorRate5xx15m: overview?.errorRate5xx15m ?? 0,
        },
      };
    });

    return context.json(projectsWithSummaries.sort(sortProjectList));
  })

  // Create a new project
  .post('/', async (context) => {
    const body = await context.req.json<{ slug: string }>();

    if (!body.slug) {
      return context.json({ error: 'slug is required' }, 400);
    }

    // Validate slug format: lowercase alphanumeric + dashes, no leading/trailing dashes
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(body.slug)) {
      return context.json({ error: 'slug must be lowercase alphanumeric with dashes' }, 400);
    }

    if (RESERVED_SLUGS.has(body.slug)) {
      return context.json({ error: 'this name is reserved' }, 400);
    }

    // Short slugs (5 chars or fewer) are reserved for paid plans
    if (body.slug.length <= 5) {
      if (context.get('user').plan === 'free') {
        return context.json(
          { error: 'short slugs (5 characters or fewer) require a paid plan' },
          403,
        );
      }
    }

    // Check for slug uniqueness
    const existing = await getProjectBySlug(context.get('db'), body.slug);
    if (existing) {
      return context.json({ error: 'slug already taken' }, 409);
    }

    const userId = context.get('user').id;
    try {
      const project = await createProject(context.get('db'), userId, body.slug);
      return context.json(project, 201);
    } catch (err) {
      // Unique constraint violation — slug was taken between check and insert
      if (
        err instanceof Error &&
        err.message.includes('duplicate key value violates unique constraint')
      ) {
        return context.json({ error: 'slug already taken' }, 409);
      }
      throw err;
    }
  })

  // Get project by ID
  .get('/:id', async (context) => {
    const project = await getProject(context.get('db'), context.req.param('id'));
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }
    return context.json(project);
  })

  // List deployments for a project
  .get('/:id/deployments', async (context) => {
    const project = await getProject(context.get('db'), context.req.param('id'));
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }

    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }

    const deployments = await getProjectDeployments(context.get('db'), project.id, 20);
    return context.json({
      deployments,
      activeDeploymentId: project.active_deployment_id,
    });
  })

  // Request cancellation of an active deployment
  .post('/:id/deployments/:deploymentId/cancel', async (context) => {
    const projectId = context.req.param('id');
    const deploymentId = context.req.param('deploymentId');
    const project = await getProject(context.get('db'), projectId);
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }

    const deployment = await getDeployment(context.get('db'), deploymentId);
    if (!deployment || deployment.project_id !== projectId) {
      return context.json({ error: 'deployment not found' }, 404);
    }

    const canceling = await cancelDeployment(context.get('db'), deploymentId, 'canceled by user');
    if (!canceling) {
      return context.json(
        { error: 'deployment already completed', status: deployment.status },
        409,
      );
    }

    return context.json({ ok: true, deploymentId, status: 'canceling' });
  })

  // Rollback to a previous deployment
  .post('/:id/rollback', async (context) => {
    const projectId = context.req.param('id');
    const project = await getProject(context.get('db'), projectId);
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }

    const { deploymentId, allowDestructive } = await context.req.json<{
      deploymentId: string;
      allowDestructive?: ReadonlyArray<string>;
    }>();
    if (!deploymentId) {
      return context.json({ error: 'deploymentId is required' }, 400);
    }
    if (allowDestructive !== undefined) {
      if (!Array.isArray(allowDestructive) || allowDestructive.some((m) => typeof m !== 'string')) {
        return context.json(
          { error: 'allowDestructive must be an array of migration name strings' },
          400,
        );
      }
    }

    // Pre-lock sanity check: reject fast if the deployment plainly does
    // not belong to this project. The authoritative check runs inside
    // the lock below against a freshly-read row.
    const preCheck = await getDeployment(context.get('db'), deploymentId);
    if (!preCheck || preCheck.project_id !== projectId) {
      return context.json({ error: 'deployment not found' }, 404);
    }
    if (!preCheck.retained) {
      return context.json({ error: 'deployment not retained (worker script evicted)' }, 400);
    }

    const planLimits = getPlanLimits(context.get('user').plan);
    const dispatchLimits =
      planLimits.cpuMsPerRequest > 0 || planLimits.subRequestsPerInvocation > 0
        ? {
            ...(planLimits.cpuMsPerRequest > 0 ? { cpuMs: planLimits.cpuMsPerRequest } : {}),
            ...(planLimits.subRequestsPerInvocation > 0
              ? { subRequests: planLimits.subRequestsPerInvocation }
              : {}),
          }
        : null;

    // Rollback go-live tx FIRST, routing-KV/DO writes AFTER it commits — a
    // mirror of the deploy go-live path (deploy.ts static/WfP go-live). Ordering
    // invariants:
    //
    //   - The locked tx does ONLY pg work: the row lock, all re-reads /
    //     validation / destructive-migration checks (rejections still mutate
    //     nothing), the routing-JSON computation, `setActiveDeployment`,
    //     `updateProjectType`, and `markRoutingUnpublished(target)`. No external
    //     (KV/DO) write happens inside the lock. If the tx throws, it rolls back
    //     and NOTHING external was written → no orphan (failure mode (a)).
    //
    //   - After commit the target is committed-active but flagged
    //     routing-UNPUBLISHED. The post-commit `publishRollbackRouting` writes
    //     slug/account/domain/queue KV (one retry, then swallow) and on full
    //     success re-marks `routing_published=true`. A publish failure leaves the
    //     marker false; the target is still committed-live, so the hourly
    //     `reconcileLiveRouting` safety net rebuilds its routing byte-identically
    //     and marks it published (failure mode (b)). We never fail a
    //     committed-live rollback on a routing-publish error → 200 either way,
    //     exactly like deploy.
    //
    // target.applied_migrations (and retained, manifest) are re-read
    // inside the lock because a concurrent /rename can rewrite every
    // deployment's applied_migrations via
    // renameAppliedMigrationsForProject.
    type RollbackPublishPlan = {
      migrationDiff: ReadonlyArray<string>;
      targetId: string;
      targetType: Project['type'];
      isStaticDeployment: boolean;
      routingJson: string;
      workerName: string;
      slug: string;
      userId: string;
      ownerPlan: string;
      manifest: DeployManifest | null;
    };
    // The owner's plan for the per-project account entry. The authenticated
    // caller IS the project owner (verified `project.user_id === user.id`
    // above), so `user.plan` is the owner's plan — no extra read needed (the
    // reconciler reaches the same value via `getUsersByIds`).
    const ownerPlan = context.get('user').plan;
    let plan: RollbackPublishPlan;
    try {
      plan = await context.get('db').transaction(async (tx) => {
        // Lock the project row via `SELECT … FOR UPDATE` — per-project,
        // collision-free, released automatically at tx end. MUST be the
        // first statement in the locked section so serialization is
        // established before any subsequent read or write.
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
        const txDb = tx as unknown as Db;

        // Re-read target INSIDE the lock. applied_migrations can be
        // rewritten by a concurrent /rename; manifest and retained are
        // stable in practice but re-reading is cheap and removes every
        // time-of-check / time-of-use hazard on this row.
        const target = await getDeployment(txDb, deploymentId);
        if (!target || target.project_id !== projectId) {
          throw new RollbackError(404, 'deployment not found');
        }
        if (!target.retained) {
          throw new RollbackError(400, 'deployment not retained (worker script evicted)');
        }

        // Re-read project so `active_deployment_id` and `type` reflect
        // any concurrent rollback / deploy that committed before the
        // lock was acquired. `type` and `user_id` are effectively
        // immutable but re-reading keeps the computed routing JSON
        // consistent with the exact row the flip will reference.
        const lockedProject = await getProject(txDb, projectId);
        if (!lockedProject) {
          throw new RollbackError(404, 'project not found');
        }

        const targetMigrations: Array<string> = target.applied_migrations
          ? JSON.parse(target.applied_migrations)
          : [];

        const projectMigrationNames = await getProjectMigrationNames(txDb, projectId);
        const currentActive = lockedProject.active_deployment_id
          ? await getDeployment(txDb, lockedProject.active_deployment_id)
          : null;
        const currentMigrations: Array<string> =
          projectMigrationNames.length > 0
            ? [...projectMigrationNames]
            : currentActive?.applied_migrations
              ? JSON.parse(currentActive.applied_migrations)
              : [];
        const diff = currentMigrations.filter((m) => !targetMigrations.includes(m));

        // Reject destructive rollbacks server-side unless the caller
        // explicitly opts in. `diff` holds migrations the CURRENT active
        // has run that the TARGET does not know about — typically
        // forward-only DDL (DROP TABLE, ALTER, etc.) applied after the
        // target was built. Flipping traffic to the target in this state
        // leaves the worker code expecting the OLD schema while D1 still
        // carries the evolved schema, which silently corrupts queries.
        //
        // The override is snapshot-bound, NOT a blanket boolean: the
        // caller must echo the exact set of migration names they were
        // shown at confirmation time, and the server-computed diff must
        // match that set exactly (same elements, same size). This closes
        // a TOCTOU where a concurrent deploy flips `currentActive`
        // between the caller's preflight `listDeployments` read and our
        // locked `diff` re-read — set-equality means any drift forces a
        // fresh confirmation against the new state.
        //
        // The check runs BEFORE the pg flip and any external write so a
        // rejected rollback mutates nothing.
        if (diff.length > 0) {
          const confirmed = allowDestructive ?? [];
          const confirmedSet = new Set(confirmed);
          const snapshotMatches =
            confirmed.length === diff.length && diff.every((m) => confirmedSet.has(m));
          if (!snapshotMatches) {
            // Migration names are arbitrary non-empty strings (see
            // /rename), so interpolating them raw into prose with hand-
            // rolled quoting can produce invalid JSON hints when a name
            // contains quotes / backslashes / newlines. JSON.stringify
            // the diff for the example, and expose it structurally via
            // `destructiveMigrations` so programmatic callers echo the
            // authoritative array rather than re-parsing the message.
            throw new RollbackError(
              400,
              `Rollback is destructive: current deployment has migration(s) the target does not include: ${JSON.stringify(diff)}. Retry with \`allowDestructive: ${JSON.stringify(diff)}\` to confirm this exact set.`,
              diff,
            );
          }
        }

        // Build routing JSON from the freshly-read target manifest.
        const manifest: DeployManifest | null = target.manifest
          ? JSON.parse(target.manifest)
          : null;
        // Rollback external-write pass depends only on authoritative
        // persistent sources (pg deployments table for queue activation
        // history; target's manifest + unconditional DO reconciliation
        // for crons), not on the potentially-stale currentActive manifest
        // snapshot or the eagerly-written resources table. See queue
        // sweep below for why the union uses `deployed_at IS NOT NULL`.
        const workerName = getProjectDeploymentWorkerName(lockedProject.slug, target.id);
        const existingRouting = await context.env.ROUTING.get(lockedProject.slug);
        const existingEntry = existingRouting ? JSON.parse(existingRouting) : null;

        // The serving model is a property of the TARGET deployment, not of
        // the project's CURRENT type. A normal deploy persists `projects.type`
        // from `manifest.type` at go-live (deploy.ts: static path
        // `manifest.type ?? (not_found_handling === 'single-page-application'
        // ? 'spa' : 'static')`; WfP path `manifest.type ?? (framework
        // ? 'framework' : 'void')`). If the project's type changed between the
        // current active deploy and the target (e.g. a void/framework app was
        // later converted to static/spa, or vice-versa), keying static-vs-WfP
        // off `lockedProject.type` publishes a routing entry for the WRONG
        // serving model — and the hourly reconciler (which also reads
        // `projects.type`) would re-cement it. Derive the type from the
        // target's manifest so it is identical to a fresh deploy of that
        // manifest, then restore `projects.type` below.
        //
        // Deploy discriminates static-vs-WfP by worker-file presence, then derives type
        // within the branch; manifest.type is the stored equivalent (every current CLI
        // builder emits it). Only truly-legacy typeless manifests lack it, and those can
        // only be legacy void/framework (buildStaticManifest always sets type), so default
        // typeless -> WfP (framework?framework:void). assetConfig must NOT decide the type.
        const targetType: Project['type'] =
          manifest?.type ?? (manifest?.framework ? 'framework' : 'void');
        const isStaticDeployment = targetType === 'static' || targetType === 'spa';

        let routingJson: string;
        if (isStaticDeployment) {
          const assetConfig = manifest?.assetConfig ?? {
            not_found_handling: targetType === 'spa' ? 'single-page-application' : '404-page',
          };
          routingJson = buildStaticRoutingJson({
            projectId,
            userId: lockedProject.user_id,
            deploymentId: target.id,
            assetConfig,
            manifest,
            suspended: existingEntry?.suspended,
          });
        } else {
          routingJson = buildRoutingJson({
            workerName,
            projectId,
            userId: lockedProject.user_id,
            manifest,
            deploymentId: target.id,
            dispatchLimits,
            suspended: existingEntry?.suspended,
            hasCrons: !!manifest?.schedules?.length,
            // `asset_hashes != null` is the exact proxy for "this WfP
            // deployment mirrored assets to KV/R2" (deploy.ts writes it
            // only when assetCount > 0). Without these, dispatch's
            // `maybeServeWfpAssetFallback` short-circuits on a missing
            // `assetManifestId` and can serve CF's "Assets have not yet
            // been deployed" stub as the asset after a rollback.
            assetManifestId: target.asset_hashes ? target.id : undefined,
            assetConfig: target.asset_hashes
              ? (manifest?.assetConfig ?? { not_found_handling: 'none' })
              : undefined,
          });
        }

        // PG flip FIRST, inside the lock. If this (or anything below in the tx)
        // throws, no external state was mutated yet — the tx rolls back cleanly
        // and the caller can retry (failure mode (a): nothing committed, nothing
        // published, no orphan).
        await setActiveDeployment(txDb, projectId, target.id);
        // Restore `projects.type` to the target's serving model within the
        // same tx so it tracks the now-active deployment. Without this the
        // type would still describe the OLD active deploy, and the hourly
        // reconciler (which reads `projects.type`) would re-publish a routing
        // entry for the wrong serving model after a cross-type rollback.
        // Mirrors the deploy path, which calls `updateProjectType` in its
        // own go-live tx.
        await updateProjectType(txDb, projectId, targetType);
        // Flag the now-active target routing-UNPUBLISHED within the same tx, so
        // that if the post-commit publish below fails the row stays `false` and
        // the hourly reconciler heals it. On full publish success it is re-marked
        // `true`. Mirrors deploy's `markRoutingPublished`-only model inverted for
        // the rollback flip (deploy starts a fresh deployment whose marker is
        // already NULL; rollback re-activates an old deployment that may already
        // carry `routing_published=true`, so it must be explicitly cleared).
        await markRoutingUnpublished(txDb, target.id);

        // The queue-route sweep runs post-commit inside the publish closure via
        // the shared `sweepStaleQueueRoutes`, which LISTs the project's live
        // `queue:<projectId>-` KV keys directly and drops any not in the expected
        // set — no pre-computed name union over historic manifests (the old
        // approach) is needed. The expected set is ONLY the rollback TARGET's own
        // queues: under the routing-after-tx model a `queue:<name>` route is
        // published only AFTER a deployment goes live, so a concurrent in-flight
        // deploy has written no route yet and republishes its own when it goes
        // live — there is nothing of theirs in KV to preserve. Matches the
        // reconciler.

        return {
          migrationDiff: diff,
          targetId: target.id,
          targetType,
          isStaticDeployment,
          routingJson,
          workerName,
          slug: lockedProject.slug,
          userId: lockedProject.user_id,
          ownerPlan,
          manifest,
        };
      });
    } catch (err) {
      if (err instanceof RollbackError) {
        if (err.destructiveMigrations) {
          return context.json(
            { error: err.message, destructiveMigrations: err.destructiveMigrations },
            err.status,
          );
        }
        return context.json({ error: err.message }, err.status);
      }
      throw err;
    }

    // === Routing publish (post-tx) ===
    // The rollback is committed-live (target is the active deployment, flagged
    // routing-UNPUBLISHED). Publish routing forward, mirroring deploy's
    // publish*Routing structure: try → log attempt 1 → retry → log attempt 2 →
    // swallow. A transient KV/CF failure here does NOT fail the rollback — the
    // target is committed-live and the hourly reconciler rebuilds routing
    // byte-identically from its manifest and marks it published (failure mode
    // (b)). NOT deploy's closures — those close over deploy-local state.
    //
    // Resolve the target worker's baked __VOID_PROXY_TOKEN once for BOTH the
    // queue routes and the cron sync below — the framework's /__void/queue and
    // /__void/scheduled handlers validate against the SAME __VOID_PROXY_TOKEN
    // binding, so one lookup is authoritative for both. A re-fetch per path would
    // double the CF round-trips. Memoize the resolved token but re-attempt if a
    // prior call threw, so a transient CF error on publish attempt 1 can still be
    // retried by attempt 2 / the cron sync.
    let cachedProxyToken: string | null = null;
    const resolveProxyTokenOnce = async (): Promise<string> => {
      if (cachedProxyToken !== null) {
        return cachedProxyToken;
      }
      const token = await resolveRollbackProxyToken(context.env, plan.workerName, projectId);
      cachedProxyToken = token;
      return token;
    };
    const publishRollbackRouting = async (txDb: Db): Promise<void> => {
      // RE-READ the current slug entry's `suspended` marker UNDER THE LOCK and
      // fold it into the prebuilt JSON. `plan.routingJson` was built from a
      // PRE-LOCK snapshot of `suspended` (read in the rollback prepare tx); a
      // guarded suspension (`guardedRoutingKvRmw`) can serialize FIRST and stamp
      // `suspended` onto the slug route, and writing the stale snapshot here would
      // drop that marker — dispatch then keeps serving a suspended project until
      // another mutation re-stamps (hidden behind `routing_published=true`, the
      // reconciler never heals it). The corrected JSON flows into BOTH the slug
      // write and the domain writes below.
      const slugJson = await applyCurrentSuspension(
        context.env.ROUTING,
        plan.slug,
        plan.routingJson,
      );
      await context.env.ROUTING.put(plan.slug, slugJson);
      // Per-project account entry — the old in-tx rollback omitted this; written
      // here for deploy/reconciler parity (both write `project:<id>`).
      await writeProjectAccountEntry(context.env.ROUTING, projectId, plan.userId, plan.ownerPlan);
      // Re-read the active domain set UNDER THE LOCK (via the lock-tx handle),
      // not from a pre-publish snapshot: a domain activated/deleted between the
      // go-live tx and this publish would otherwise be missed (newly-active
      // domain stranded on the old deployment) or recreated (deleted domain
      // re-published) and stamped `routing_published=true` permanently.
      const activeDomainHostnames = (await getDomainsByProjectId(txDb, projectId))
        .filter((domain) => domain.status === 'active')
        .map((domain) => domain.hostname);
      for (const hostname of activeDomainHostnames) {
        await context.env.ROUTING.put(`domain:${hostname}`, slugJson);
      }
      // ONLY the rollback target's own queue routes — the sweep drops every
      // other `queue:<projectId>-` route. Under the routing-after-tx model no
      // in-flight deploy has written a queue route yet (routes publish only
      // post-go-live), so there is nothing of theirs to preserve here. A rollback
      // whose TARGET is static binds NO queues and has NO consumer worker, so its
      // expected set stays EMPTY — the queue-route WRITES are WfP-only, but the
      // sweep below STILL runs to drop any `queue:<projectId>-` route left over
      // from the pre-rollback WfP deployment.
      const expectedQueueKeys = new Set<string>();
      if (!plan.isStaticDeployment) {
        const queues = plan.manifest?.queues ?? [];
        for (const q of queues) {
          expectedQueueKeys.add(`queue:${getProjectQueueName(projectId, q.name)}`);
          await context.env.ROUTING.put(
            `queue:${getProjectQueueName(projectId, q.name)}`,
            JSON.stringify({
              workerName: plan.workerName,
              projectId,
              queueName: q.name,
              proxyToken: await resolveProxyTokenOnce(),
            }),
          );
        }
      }
      // Delete-sweep: drop queue routes from older deployments the target does
      // not bind. Idempotent (KV delete on a missing key is a no-op), so it is
      // retry-safe across both publish attempts. The shared
      // `sweepStaleQueueRoutes` LISTs every `queue:<projectId>-` key and drops
      // any not in `expectedQueueKeys` (the target's own queues, or EMPTY for a
      // static target). Runs UNCONDITIONALLY so a rollback to a static target
      // still sweeps the pre-rollback WfP deployment's queue routes.
      await sweepStaleQueueRoutes(context.env.ROUTING, projectId, expectedQueueKeys);

      // Cron DO sync — runs INSIDE this publish closure, so it is gated by the
      // project lock + active-pointer re-check `publishRoutingIfStillActive`
      // holds: the closure fires ONLY on a still-active target ('published'),
      // and is NOT invoked on 'superseded', so an overtaken rollback can never
      // clobber the newer active op's project-keyed schedules. That closes the
      // released-lock window the old post-return cron block had (which gated on
      // the stale `publishOutcome !== 'superseded'` and so also fired on
      // 'failed'). The sync/clear themselves stay BEST-EFFORT via the shared
      // client helpers (retry-then-swallow, same as the deploy path): a transient
      // CronScheduler DO blip must NOT fail the routing publish — routing KV is
      // already correct, and cron drift self-heals on the next deploy (the
      // reconciler heals routing, not cron). When the target has no schedules,
      // `/clear` runs unconditionally (idempotent) so a prior cutover's stale DO
      // schedules do not persist. `resolveProxyTokenOnce` is reused (memoized) so
      // cron + queues share a single CF round-trip.
      if (plan.manifest?.schedules?.length) {
        await syncCronScheduler(context.env, projectId, {
          workerName: plan.workerName,
          schedules: plan.manifest.schedules,
          proxyToken: await resolveProxyTokenOnce(),
        });
      } else {
        await clearCronScheduler(context.env, projectId);
      }
    };
    // `publishRoutingIfStillActive` re-acquires the project-row FOR UPDATE lock
    // (the SAME lock the rollback/deploy go-live tx and reconciler take) in a
    // separate post-commit tx, RE-READS `active_deployment_id`, and only
    // publishes + marks under the lock IF the rollback target is still active.
    // If a newer deploy/rollback committed while this rollback's publish was
    // parked, the re-check returns 'superseded': SKIP the KV writes (incl. the
    // queue delete-sweep — a stale sweep would delete queue routes the newer
    // active needs) AND the cron DO sync AND the mark. The pointer flip already
    // committed (200 either way); the newer op owns routing. The publish stays
    // POST-commit; a publish failure never rolls back the committed flip. The
    // cron DO sync/clear now runs INSIDE `publishRollbackRouting` (after the
    // routing/queue writes), so it is serialized under the same project lock as
    // routing and runs ONLY on 'published' (not on 'superseded' — closure not
    // invoked — and not on 'failed' — the closure threw, row left unmarked).
    // `resolveProxyTokenOnce` stays memoized across attempts AND that cron sync.
    let publishOutcome: Awaited<ReturnType<typeof publishRoutingIfStillActive>>;
    try {
      publishOutcome = await publishRoutingIfStillActive(
        context.get('db'),
        projectId,
        plan.targetId,
        publishRollbackRouting,
      );
      if (publishOutcome === 'failed') {
        console.warn(`[rollback] routing publish failed (attempt 1) for slug ${plan.slug}`);
        publishOutcome = await publishRoutingIfStillActive(
          context.get('db'),
          projectId,
          plan.targetId,
          publishRollbackRouting,
        );
        if (publishOutcome === 'failed') {
          console.warn(`[rollback] routing publish failed (attempt 2) for slug ${plan.slug}`);
        }
      }
    } catch (err) {
      // The post-commit publish helper REJECTED — e.g. a transient pg/Hyperdrive
      // error taking the FOR UPDATE lock or committing the short publish tx —
      // which is DISTINCT from a 'failed' RETURN (the `publish()` KV writes threw,
      // already handled above). The go-live tx already committed (the rollback
      // target is active, routing_published=false), so NEVER fail a committed-live
      // rollback: treat a rejection exactly like 'failed'. The hourly
      // `reconcileLiveRouting` heals the route byte-identically, the same as a
      // 'failed' attempt. Mirrors the deploy path's committed-live recovery.
      console.warn(
        `[rollback] routing publish threw post-commit for slug ${plan.slug}; rollback is committed-live, reconciler will heal`,
        err,
      );
      publishOutcome = 'failed';
    }
    // 'published' → target owns + published routing (mark set under the lock).
    // 'superseded' → a newer op overtook the target; KV untouched (no clobber,
    // no stale queue-route deletion), no mark. 'failed' → row stays unmarked and
    // the hourly `reconcileLiveRouting` safety net heals it byte-identically.
    if (publishOutcome === 'superseded') {
      console.log(
        `[rollback] routing publish superseded for slug ${plan.slug}: target ${plan.targetId} is no longer active (a newer op owns routing)`,
      );
    }

    return context.json({
      ok: true,
      deploymentId,
      migrationDiff: plan.migrationDiff,
    });
  })

  // Get migration status for a project
  .get('/:id/migrations', async (context) => {
    const project = await getProject(context.get('db'), context.req.param('id'));
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }

    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }

    const resources = await getProjectResources(context.get('db'), project.id);
    const requestedDialect = context.req.query('dialect');
    if (
      requestedDialect !== undefined &&
      requestedDialect !== 'sqlite' &&
      requestedDialect !== 'postgresql'
    ) {
      return context.json({ error: 'invalid dialect, must be sqlite or postgresql' }, 400);
    }

    if (
      requestedDialect === 'postgresql' ||
      (requestedDialect === undefined &&
        resources.some((r) => r.type === 'hyperdrive') &&
        !resources.some((r) => r.type === 'd1'))
    ) {
      const applied = await getProjectMigrationRows(context.get('db'), project.id);
      return context.json({ applied });
    }

    const d1Resource = resources.find((r) => r.type === 'd1');
    if (!d1Resource) {
      return context.json({ applied: [] });
    }

    // Torn-read safety across an in-flight legacy → _void_migrations upgrade.
    //
    // The upgrade sequence is three non-atomic D1 calls:
    //   1. CREATE TABLE _void_migrations
    //   2. INSERT OR IGNORE ... FROM _migrations
    //   3. DROP TABLE _migrations
    //
    // Reading _void_migrations first and _migrations second is unsafe: a GET
    // that sees an empty _void_migrations (pre-upgrade) and then races past
    // step 3 sees _migrations missing too — and returns `{ applied: [] }`
    // even though migrations are applied.
    //
    // Reading _migrations FIRST is race-free because of the upgrade invariant:
    // _migrations can only disappear AFTER its rows were copied into
    // _void_migrations. So:
    //
    //   - If legacy read succeeds, we captured the pre-upgrade state.
    //   - If legacy is missing, either it never existed or the upgrade is
    //     past step 2, so _void_migrations is authoritative.
    //
    // Dedup uses a name → applied_at map with last-write-wins, and
    // _void_migrations is always read second so its timestamps win on
    // overlaps (matching the pre-fix "primary is _void_migrations" semantics).
    const byName = new Map<string, string>();

    try {
      const legacy = await queryD1(
        context.env.CF_ACCOUNT_ID,
        context.env.CF_API_TOKEN,
        d1Resource.cf_id,
        {
          sql: 'SELECT name, applied_at FROM _migrations ORDER BY name',
        },
      );
      for (const r of legacy.results) {
        byName.set(r.name as string, r.applied_at as string);
      }
    } catch (err) {
      if (!isMissingTableError(err)) {
        return context.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    try {
      const result = await queryD1(
        context.env.CF_ACCOUNT_ID,
        context.env.CF_API_TOKEN,
        d1Resource.cf_id,
        {
          sql: 'SELECT name, applied_at FROM _void_migrations ORDER BY name',
        },
      );
      for (const r of result.results) {
        byName.set(r.name as string, r.applied_at as string);
      }
    } catch (err) {
      if (!isMissingTableError(err)) {
        return context.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    const applied = Array.from(byName, ([name, applied_at]) => ({ name, applied_at })).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    return context.json({ applied });
  })

  // Apply migrations to a project's remote D1 database
  .post('/:id/migrations/apply', async (context) => {
    const projectId = context.req.param('id');
    const project = await getProject(context.get('db'), projectId);
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }

    const body = await context.req.json<{
      migrations: ReadonlyArray<{ name: string; sql: string }>;
      migrationProtocolVersion?: number;
      executionPlans?: ReadonlyArray<Record<string, unknown>>;
    }>();
    if (!body.migrations || !Array.isArray(body.migrations)) {
      return context.json({ error: 'migrations array required' }, 400);
    }
    const invalidEntry = body.migrations.find(
      (m) => typeof m.name !== 'string' || !m.name || typeof m.sql !== 'string',
    );
    if (invalidEntry) {
      return context.json(
        { error: 'each migration must have a non-empty string "name" and string "sql"' },
        400,
      );
    }
    const nameSet = new Set<string>();
    for (const m of body.migrations) {
      if (nameSet.has(m.name)) {
        return context.json({ error: `duplicate migration name: ${m.name}` }, 400);
      }
      nameSet.add(m.name);
    }
    const planValidationError = await validateSubmittedExecutionPlans(
      body.migrations,
      body.executionPlans,
    );
    if (planValidationError) {
      return context.json({ error: planValidationError }, 400);
    }

    // Serialize /apply and /rename per project via a pg transaction-scoped
    // row lock on the `projects` row. The critical section holds a pg
    // connection open across remote D1 HTTP calls — not ideal for pool
    // pressure, but these are low-QPS operator flows and correctness
    // trumps efficiency here. The lock prevents an /apply that landed
    // in D1 but has not yet appended to pg metadata from being
    // overtaken by a /rename whose snapshot misses the unwritten row,
    // which would leave D1 and pg permanently diverged.
    try {
      const outcome = await context.get('db').transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        // Per-project row lock. Must be the first statement so all
        // subsequent reads/writes serialize against any concurrent
        // /apply, /rename, or /rollback holding the same row.
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);

        const resources = await getProjectResources(txDb, projectId);
        const d1Resource = resources.find((r) => r.type === 'd1');
        if (!d1Resource) {
          return { status: 400 as const, body: { error: 'no D1 database found for this project' } };
        }

        // Filter to pending-only before validating destructive patterns
        const applied = await ensureTrackingTable(
          context.env.CF_ACCOUNT_ID,
          context.env.CF_API_TOKEN,
          d1Resource.cf_id,
        );
        const pending = body.migrations.filter((m) => !applied.has(m.name));

        const violations = hasUnauthorizedDestructive(pending);
        if (violations.length > 0) {
          return {
            status: 400 as const,
            body: {
              ok: false,
              error: `Destructive migrations without pragma: ${violations.join(', ')}. Add "${DESTRUCTIVE_PRAGMA}" to allow.`,
            },
          };
        }

        const result = await runRemoteMigrations(
          context.env.CF_ACCOUNT_ID,
          context.env.CF_API_TOKEN,
          d1Resource.cf_id,
          body.migrations,
          applied,
        );

        // Re-read the project inside the lock so active_deployment_id
        // reflects any concurrent rollback / setActive commit that landed
        // while we were blocked on the lock.
        const locked = await getProject(txDb, projectId);
        // Append the UNION of applied + skipped, not just applied.
        //
        // If a previous /apply landed the migration in D1 but the pg
        // metadata write failed, the D1 tracking row is already present.
        // A retry with the same payload then classifies the name as
        // `skipped` (not `applied`). Gating the metadata write on
        // `applied.length > 0` would leave pg permanently missing the
        // name despite D1 having it — corrupting future rollback diffs
        // and rename operations.
        //
        // `appendAppliedMigrations` de-dupes via `SELECT ... FOR UPDATE`
        // + union, so passing names already present in pg is a safe
        // no-op. Passing `skipped` makes the retry reconcile pg from the
        // source of truth (D1's `_void_migrations`).
        //
        // `result.failed` may be set when a mid-batch migration threw —
        // the runner returns the committed prefix (applied + skipped)
        // that DID land in D1 along with the failing pair, and we append
        // the prefix to pg metadata before surfacing the error. The
        // prefix MUST be persisted inside the locked tx so a retry with
        // the same payload sees pg matching D1 and heals idempotently.
        // Returning a non-200 outcome is load-bearing: `return` commits
        // the tx (preserving the healing write) while a `throw` would
        // roll it back.
        const effectiveNames = [...result.applied, ...result.skipped];
        if (effectiveNames.length > 0) {
          await appendProjectMigrations(
            txDb,
            projectId,
            effectiveNames,
            locked?.active_deployment_id ?? undefined,
          );
        }
        if (effectiveNames.length > 0 && locked?.active_deployment_id) {
          await appendAppliedMigrations(txDb, locked.active_deployment_id, effectiveNames);
        }

        if (result.failed) {
          const responseBody: Record<string, unknown> = {
            ok: false,
            error: `migration ${result.failed.name} failed: ${result.failed.error}`,
            applied: result.applied,
            skipped: result.skipped,
            failed: result.failed,
          };
          if (body.migrationProtocolVersion === 2) {
            responseBody.migration_protocol = 'legacy';
            responseBody.migration_stability = 'legacy';
          }
          return {
            status: 500 as const,
            body: responseBody,
          };
        }

        const responseBody: Record<string, unknown> = {
          ok: true,
          applied: result.applied,
          skipped: result.skipped,
        };
        if (body.migrationProtocolVersion === 2) {
          responseBody.migration_protocol = 'legacy';
          responseBody.migration_stability = 'legacy';
          responseBody.warnings = [
            'Remote D1 REST migrations use the legacy compensating runner; deploy-time worker protocol v2 provides the stable migration contract.',
          ];
        }
        return {
          status: 200 as const,
          body: responseBody,
        };
      });
      return context.json(outcome.body, outcome.status);
    } catch (err) {
      return context.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  })

  // Rename migration records in a project's remote D1 database
  .post('/:id/migrations/rename', async (context) => {
    const projectId = context.req.param('id');
    const project = await getProject(context.get('db'), projectId);
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }

    const body = await context.req.json<{ renames: ReadonlyArray<{ from: string; to: string }> }>();
    if (!body.renames || !Array.isArray(body.renames) || body.renames.length === 0) {
      return context.json({ error: 'renames array required' }, 400);
    }
    const invalidRename = body.renames.find(
      (r) => typeof r.from !== 'string' || !r.from || typeof r.to !== 'string' || !r.to,
    );
    if (invalidRename) {
      return context.json({ error: 'each rename must have non-empty string "from" and "to"' }, 400);
    }

    // Batch-level validation: the remote UPDATEs are non-atomic, so any
    // partial commit on a PK collision leaves `_void_migrations` half-renamed
    // with no automatic rollback. Rejecting ambiguous or self-conflicting
    // batches up front means a clean DB can never hit a collision mid-batch.
    const fromSet = new Set<string>();
    const toSet = new Set<string>();
    for (const { from } of body.renames) {
      if (fromSet.has(from)) {
        return context.json({ error: 'duplicate "from" in rename batch' }, 400);
      }
      fromSet.add(from);
    }
    for (const { to } of body.renames) {
      if (toSet.has(to)) {
        return context.json({ error: 'duplicate "to" in rename batch' }, 400);
      }
      toSet.add(to);
    }
    // Chains and cycles (`a→b, b→c` or `a→b, b→a`) would need two-phase
    // renames across non-atomic D1 calls to avoid a mid-batch PK collision.
    // Rejecting them forces the caller to split the work into separate
    // requests and keeps this handler's execution path strictly linear.
    for (const { to } of body.renames) {
      if (fromSet.has(to)) {
        return context.json(
          {
            error:
              'rename "to" conflicts with another rename "from" in batch — chains not supported',
          },
          400,
        );
      }
    }

    // Serialize /apply and /rename per project via a pg transaction-scoped
    // row lock on the `projects` row. Holding the lock across the D1
    // HTTP calls is what prevents the /apply-vs-/rename interleave where
    // /apply writes a row to D1, /rename then snapshots D1 + rewrites pg
    // (missing the new row), and /apply finally appends the pre-rename
    // name to pg.
    try {
      const outcome = await context.get('db').transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        // Per-project row lock. Must be the first statement so all
        // subsequent reads/writes serialize against any concurrent
        // /apply, /rename, or /rollback holding the same row.
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);

        const resources = await getProjectResources(txDb, projectId);
        const d1Resource = resources.find((r) => r.type === 'd1');
        if (!d1Resource) {
          return { status: 400 as const, body: { error: 'no D1 database found for this project' } };
        }

        // Ensure tracking table exists and upgrade legacy _migrations if needed.
        // The returned set is the current applied state — reused for validation
        // below so we don't issue a redundant SELECT.
        const existing = await ensureTrackingTable(
          context.env.CF_ACCOUNT_ID,
          context.env.CF_API_TOKEN,
          d1Resource.cf_id,
        );

        // DB-state validation. The semantics below exist so that retries after
        // a partial failure are safe and idempotent, not just fresh batches:
        //
        //   - unknown `from` AND unknown `to`  → 400 (genuine operator error)
        //   - unknown `from` AND known   `to`  → ambiguous: only treat as an
        //     already-landed rename when pg metadata still references `from`
        //     somewhere (the fingerprint of a legitimate retry after a prior
        //     D1-succeeded / pg-failed run). Otherwise 400 — see below.
        //   - known   `from` AND known   `to`  → 400 (would collide on UPDATE,
        //     unless the existing `to` row is itself also being renamed away —
        //     but batch-level validation already rejects chains, so that case
        //     cannot occur here)
        //   - known   `from` AND unknown `to`  → proceed (normal case)
        const missingFrom: Array<string> = [];
        const collidingTo: Array<string> = [];
        const effective: Array<{ from: string; to: string }> = [];
        const alreadyLanded: Array<{ from: string; to: string }> = [];
        for (const { from, to } of body.renames) {
          const fromExists = existing.has(from);
          const toExists = existing.has(to);
          if (!fromExists && !toExists) {
            missingFrom.push(from);
            continue;
          }
          if (!fromExists && toExists) {
            // The `!fromExists && toExists` branch must NOT unconditionally
            // classify as an idempotent retry. A request targeting an
            // unrelated existing migration (e.g., pg has `001_init.sql`
            // and D1 happens to have `002_add_email.sql` from a different
            // deploy) would silently rewrite pg to a wrong target.
            //
            // The fingerprint of a legitimate retry after a prior
            // D1-succeeded / pg-failed run is: D1 has `to`, D1 lacks `from`
            // (already renamed in D1), and pg STILL has `from` on the
            // ACTIVE deployment (the failed pg write left it stale).
            //
            // Corroboration is restricted to the ACTIVE deployment.
            // Stale retained rows from older code paths could be
            // historically inaccurate and are not trustworthy corroboration.
            //
            // A second corroboration source (the `migration_renames` audit
            // log) is required because partial-failure heal writes pg's
            // `applied_migrations` BEFORE surfacing the later pair's
            // failure — so once an earlier pair's committed prefix is
            // persisted, the active deployment no longer references
            // `from`. A same-payload retry that exercises the
            // still-failing pair must still be able to pass the
            // committed prefix through the classifier idempotently, or
            // the operator is wedged with no way to retry. The audit log
            // is written in the same locked tx as the heal, so a matching
            // row is durable proof that this exact (project_id, from, to)
            // rename was already committed here — which fat-finger
            // requests will never have.
            const stalePg = await activeDeploymentContainsMigration(txDb, projectId, from);
            const auditLogged = stalePg
              ? false
              : await migrationRenameExists(txDb, projectId, from, to);
            if (!stalePg && !auditLogged) {
              return {
                status: 400 as const,
                body: {
                  ok: false,
                  error:
                    `rename "${from}" → "${to}" is ambiguous: D1 already has "${to}" and no deployment ` +
                    `metadata references "${from}". Refusing to rewrite metadata without corroboration.`,
                },
              };
            }
            // Already-landed rename — idempotent no-op, but still record the
            // pair so pg metadata gets rewritten if it is stale.
            alreadyLanded.push({ from, to });
            continue;
          }
          if (fromExists && toExists) {
            collidingTo.push(to);
            continue;
          }
          effective.push({ from, to });
        }
        if (missingFrom.length > 0) {
          return {
            status: 400 as const,
            body: { error: `unknown "from" migration(s): ${missingFrom.join(', ')}` },
          };
        }
        if (collidingTo.length > 0) {
          return {
            status: 400 as const,
            body: { error: `"to" migration(s) already exist: ${collidingTo.join(', ')}` },
          };
        }

        // After validation, no clean-DB batch can hit a PK collision. Network
        // failures mid-batch can still leave partial state, but retries with
        // the same payload are safe because every already-landed rename is
        // detected by the validation block above and skipped.
        //
        // meta.changes is inspected on every UPDATE. When two concurrent
        // /rename requests both pass pre-validation against the same
        // `from`, only one UPDATE actually changes a row — the loser sees
        // `changes === 0`. We re-query `_void_migrations` to classify the
        // zero-changes case:
        //
        //   - if the row we wanted (`to`) is already present AND `from` is
        //     gone, a concurrent winner achieved the same end state and we
        //     treat this pair as already-landed (skip in D1, still rewrite
        //     pg metadata so stale entries get fixed).
        //   - otherwise the winner redirected `from` to some OTHER target,
        //     so our rename lost a race to a conflicting target → return
        //     409 and do NOT append this pair to the pg rewrite set.
        //
        // Only pairs whose D1 UPDATE actually changed a row (or that
        // classified as already-landed via the recheck) are forwarded to
        // `renameAppliedMigrationsForProject`.
        // Committed pairs MUST be persisted to pg even when a later pair
        // in the same batch fails. Earlier iterations landed their UPDATE
        // in D1 — that state is durable and cannot be rolled back by
        // throwing. Throwing would also bubble out of the locked tx and
        // roll back any pg rewrite, leaving pg's applied_migrations arrays
        // pointing at the old names while D1 already holds the new names.
        //
        // So: stash the per-pair failure, STOP the loop (continuing past
        // a 409 risks later pairs being misclassified against the winner's
        // rewritten rows), persist the committed prefix via
        // `renameAppliedMigrationsForProject` inside the same locked tx,
        // and then `return` a 409/500 outcome. A `return` commits the tx
        // (preserving the heal); a `throw` would roll it back.
        const committed: Array<{ from: string; to: string }> = [...alreadyLanded];
        type PairFailure =
          | { kind: 'conflict'; from: string; to: string }
          | { kind: 'error'; from: string; to: string; error: string };
        let pairFailure: PairFailure | undefined;
        for (const { from, to } of effective) {
          let update: Awaited<ReturnType<typeof queryD1>>;
          try {
            update = await queryD1(
              context.env.CF_ACCOUNT_ID,
              context.env.CF_API_TOKEN,
              d1Resource.cf_id,
              {
                sql: 'UPDATE _void_migrations SET name = ? WHERE name = ?',
                params: [to, from],
              },
            );
          } catch (err) {
            pairFailure = {
              kind: 'error',
              from,
              to,
              error: err instanceof Error ? err.message : String(err),
            };
            break;
          }
          if ((update.meta?.changes ?? 1) > 0) {
            committed.push({ from, to });
            continue;
          }
          // Zero rows affected — a concurrent rename already moved `from`.
          // Re-check the tracking table to see whether the winner landed on
          // the same `to` we wanted (benign) or a different target (conflict).
          let recheck: Awaited<ReturnType<typeof queryD1>>;
          try {
            recheck = await queryD1(
              context.env.CF_ACCOUNT_ID,
              context.env.CF_API_TOKEN,
              d1Resource.cf_id,
              {
                sql: 'SELECT name FROM _void_migrations WHERE name = ? OR name = ?',
                params: [from, to],
              },
            );
          } catch (err) {
            pairFailure = {
              kind: 'error',
              from,
              to,
              error: err instanceof Error ? err.message : String(err),
            };
            break;
          }
          const names = new Set(recheck.results.map((r) => r.name as string));
          if (!names.has(from) && names.has(to)) {
            // Winner happened to pick the same target — our end state holds.
            committed.push({ from, to });
            continue;
          }
          pairFailure = { kind: 'conflict', from, to };
          break;
        }

        // Rewrite applied_migrations for EVERY deployment of this project,
        // not just the active one — retained and inactive deployments would
        // otherwise keep the old names and break rollback diffs that compare
        // `applied_migrations` arrays across deployments. Only renames whose
        // D1 UPDATE actually committed (or that we classified as an already-
        // landed retry) are forwarded — conflicted pairs never reach here.
        //
        // This runs BEFORE surfacing any pair-level failure so the
        // committed prefix is persisted atomically with the `return` below.
        //
        // The `migration_renames` audit log entry is the durable second
        // corroboration source that lets a same-payload retry after a
        // partial-failure heal classify already-committed pairs as
        // idempotent — `renameAppliedMigrationsForProject` has just erased
        // any `from` reference from the active deployment, so the
        // `activeDeploymentContainsMigration` check would otherwise reject
        // the committed prefix on retry and wedge the operator.
        //
        // Before recording each committed pair, invalidate any prior audit
        // rows whose `to_name` matches the new pair's `from`. Those rows
        // claim "some earlier rename landed at `from`", but `from` is now
        // being renamed AWAY — the landing claim is no longer valid, and
        // a fat-fingered retry quoting a recycled lineage must not be
        // corroborated by the stale row. Invalidation runs inside the
        // same locked tx as the heal/record, so a rollback unwinds all
        // three together.
        if (committed.length > 0) {
          await renameProjectMigrations(txDb, projectId, committed);
          await renameAppliedMigrationsForProject(txDb, projectId, committed);
          for (const { from } of committed) {
            await invalidateMigrationRenamesForOldName(txDb, projectId, from);
          }
          await recordMigrationRenames(txDb, projectId, committed);
        }

        if (pairFailure) {
          if (pairFailure.kind === 'conflict') {
            return {
              status: 409 as const,
              body: {
                ok: false,
                error: `rename conflict: "${pairFailure.from}" was concurrently renamed to a different target`,
                committed,
              },
            };
          }
          return {
            status: 500 as const,
            body: {
              ok: false,
              error: `rename "${pairFailure.from}" → "${pairFailure.to}" failed: ${pairFailure.error}`,
              committed,
            },
          };
        }

        return { status: 200 as const, body: { ok: true } };
      });
      return context.json(outcome.body, outcome.status);
    } catch (err) {
      return context.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  })

  // List resources for a project
  .get('/:id/resources', async (context) => {
    const project = await getProject(context.get('db'), context.req.param('id'));
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }
    const resources = await getProjectResources(context.get('db'), project.id);
    return context.json(resources);
  })

  // Fetch logs for a project
  .get('/:id/logs', async (context) => {
    const project = await getProject(context.get('db'), context.req.param('id'));
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }

    const since = context.req.query('since') ?? '1h';
    const sinceMs = parseDuration(since);
    if (sinceMs === null) {
      return context.json({ error: 'invalid since parameter, use format like 15m, 2h, 3d' }, 400);
    }

    const limit = Math.min(parseInt(context.req.query('limit') ?? '200', 10) || 200, 500);
    const deploymentId = context.req.query('deploymentId');
    if (deploymentId && !/^dpl_[0-9a-z]+$/.test(deploymentId)) {
      return context.json({ error: 'invalid deploymentId format' }, 400);
    }

    // Optional level filter applied at the AE SQL layer so sparse error rows
    // are not hidden behind successful invocations by the LIMIT clause. The
    // 'all' value is treated as absence; any other value must be in the fixed
    // allowlist (allowlist check, not regex, so future code can't widen this
    // accidentally and let a tainted value reach the SQL string).
    const levelParam = context.req.query('level');
    const ALLOWED_LEVELS = ['error', 'warn', 'info', 'log', 'debug'] as const;
    type LogLevel = (typeof ALLOWED_LEVELS)[number];
    let level: LogLevel | null = null;
    if (levelParam !== undefined && levelParam !== 'all') {
      if (!(ALLOWED_LEVELS as ReadonlyArray<string>).includes(levelParam)) {
        return context.json(
          {
            error: `invalid level parameter, must be one of: error, warn, info, log, debug, all`,
          },
          400,
        );
      }
      level = levelParam as LogLevel;
    }

    const workerName = `user-${project.slug}`;
    const sinceStr = new Date(Date.now() - sinceMs).toISOString().replace('T', ' ').slice(0, 19);
    const dataset = context.env.LOGS_DATASET ?? 'void_logs';

    const deployFilter = deploymentId ? `\n        AND blob7 = '${deploymentId}'` : '';
    let levelFilter = '';
    if (level === 'error') {
      // Catch non-ok outcomes (blob1), captured exceptions (blob3 non-empty
      // array), and console.error logs (blob2 has level:"error").
      levelFilter = `\n        AND (blob1 != 'ok' OR blob3 != '[]' OR blob2 LIKE '%"level":"error"%')`;
    } else if (level !== null) {
      levelFilter = `\n        AND blob2 LIKE '%"level":"${level}"%'`;
    }

    const query = `
      SELECT
        blob1 as outcome,
        blob2 as logData,
        blob3 as exceptionData,
        blob4 as url,
        blob5 as method,
        blob6 as statusCode,
        blob7 as deployId,
        double1 as ts,
        timestamp
      FROM ${dataset}
      WHERE index1 = '${workerName}'
        AND timestamp >= toDateTime('${sinceStr}')${deployFilter}${levelFilter}
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `;

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${context.env.CF_ACCOUNT_ID}/analytics_engine/sql`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${context.env.CF_API_TOKEN}`,
          'Content-Type': 'text/plain',
        },
        body: query,
      },
    );

    const responseText = await response.text();
    if (!response.ok) {
      console.error(
        `[logs] query failed for project ${project.id} (${response.status}): ${responseText.slice(0, 500)}`,
      );
      return context.json(
        { error: 'log query failed', status: response.status, detail: responseText.slice(0, 500) },
        502,
      );
    }

    // CF's Analytics Engine API normally returns JSON, but a 2xx response can
    // carry an HTML error page during edge incidents (status pages, DDoS
    // interstitials). Parse defensively so the handler returns a clean 502
    // instead of throwing an uncaught SyntaxError that Hono maps to a 500.
    let result: {
      data: ReadonlyArray<{
        outcome: string;
        logData: string;
        exceptionData: string;
        url: string;
        method: string;
        statusCode: string;
        ts: number;
      }>;
    };
    try {
      result = JSON.parse(responseText) as typeof result;
    } catch {
      console.error(
        `[logs] non-JSON response for project ${project.id} (${response.status} ${response.headers.get('content-type') ?? 'unknown'}): ${responseText.slice(0, 500)}`,
      );
      return context.json(
        {
          error: 'log query returned non-JSON response',
          status: response.status,
          detail: responseText.slice(0, 500),
        },
        502,
      );
    }

    // Query newest-first to match the working admin path, then return entries
    // in chronological order for CLI readability.
    const data = [...(result.data ?? [])].reverse().map((row) => ({
      timestamp: row.ts,
      outcome: row.outcome,
      logs: tryParse(row.logData),
      exceptions: tryParse(row.exceptionData),
      url: row.url,
      method: row.method,
      status: row.statusCode,
    }));

    return context.json({ data });
  })

  // Provision Hyperdrive for a PostgreSQL project
  .post('/:id/database', async (context) => {
    const projectId = context.req.param('id');
    const project = await getProject(context.get('db'), projectId);
    if (!project || project.user_id !== context.get('user').id) {
      return context.json({ error: 'Not found' }, 404);
    }

    const { connectionString } = await context.req.json<{ connectionString: string }>();
    if (!connectionString?.startsWith('postgres')) {
      return context.json({ error: 'Invalid connection string' }, 400);
    }

    const { createHyperdrive, updateHyperdrive, getHyperdriveByName } =
      await import('../provisioning/cloudflare-api.ts');
    const { createResource, getProjectResources } = await import('../db.ts');

    // Check if Hyperdrive already exists
    const existing = await getProjectResources(context.get('db'), projectId);
    const found = existing.find((r) => r.type === 'hyperdrive');
    if (found) {
      return context.json(
        { error: 'Hyperdrive already provisioned. Use PUT /database-url to update.' },
        409,
      );
    }

    const resourceName = getHyperdriveResourceName(projectId);
    let hyperdriveId: string;
    try {
      const hd = await createHyperdrive(
        context.env.CF_ACCOUNT_ID,
        context.env.CF_API_TOKEN,
        resourceName,
        connectionString,
      );
      hyperdriveId = hd.id;
    } catch (err: unknown) {
      if (isAlreadyExistsError(err)) {
        // CF already has a Hyperdrive for this name (orphaned from a prior partial failure).
        // Look up its ID and update it with the submitted connectionString so CF reflects
        // what we're about to store — never persist a URL that CF hasn't accepted.
        try {
          const hd = await getHyperdriveByName(
            context.env.CF_ACCOUNT_ID,
            context.env.CF_API_TOKEN,
            resourceName,
          );
          await updateHyperdrive(
            context.env.CF_ACCOUNT_ID,
            context.env.CF_API_TOKEN,
            hd.id,
            connectionString,
            resourceName,
          );
          hyperdriveId = hd.id;
        } catch (lookupErr: unknown) {
          const response = toDatabaseProvisioningError(lookupErr);
          if (response) {
            return context.json(response.body, response.status);
          }
          throw lookupErr;
        }
      } else {
        const response = toDatabaseProvisioningError(err);
        if (response) {
          return context.json(response.body, response.status);
        }
        throw err;
      }
    }

    // CF accepted the connection string — persist it as our cached copy.
    // CF is the source of truth for production routing; this row is the URL
    // that CF accepted and is now serving. If this upsert fails (rare),
    // instruct the user to re-run `void db set-url` to re-sync.
    try {
      const encrypted = await encryptProjectSecret(
        context.env,
        projectId,
        'database-url',
        connectionString,
      );
      await upsertProjectDatabaseUrl(
        context.get('db'),
        projectId,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.keyVersion,
      );
    } catch {
      return context.json(
        {
          error:
            'Failed to persist database URL after Cloudflare accepted it. Run `void db set-url` again to re-sync.',
        },
        500,
      );
    }

    await createResource(context.get('db'), projectId, 'hyperdrive', hyperdriveId, 'HYPERDRIVE');
    return context.json({ ok: true });
  })

  // Update PostgreSQL connection string (updates Hyperdrive config)
  .put('/:id/database-url', async (context) => {
    const projectId = context.req.param('id');
    const project = await getProject(context.get('db'), projectId);
    if (!project || project.user_id !== context.get('user').id) {
      return context.json({ error: 'Not found' }, 404);
    }

    const { connectionString } = await context.req.json<{ connectionString: string }>();
    if (!connectionString?.startsWith('postgres')) {
      return context.json({ error: 'Invalid connection string' }, 400);
    }

    const { createHyperdrive, updateHyperdrive, getHyperdriveByName } =
      await import('../provisioning/cloudflare-api.ts');
    const { createResource, getProjectResources } = await import('../db.ts');

    const existing = await getProjectResources(context.get('db'), projectId);
    const found = existing.find((r) => r.type === 'hyperdrive');

    if (found) {
      // Update existing Hyperdrive config
      try {
        const resourceName = getHyperdriveResourceName(projectId);
        await updateHyperdrive(
          context.env.CF_ACCOUNT_ID,
          context.env.CF_API_TOKEN,
          found.cf_id,
          connectionString,
          resourceName,
        );
      } catch (err: unknown) {
        const response = toDatabaseProvisioningError(err);
        if (response) {
          return context.json(response.body, response.status);
        }
        throw err;
      }
    } else {
      // Create new Hyperdrive config
      const resourceName = getHyperdriveResourceName(projectId);
      let hyperdriveId: string;
      try {
        const hd = await createHyperdrive(
          context.env.CF_ACCOUNT_ID,
          context.env.CF_API_TOKEN,
          resourceName,
          connectionString,
        );
        hyperdriveId = hd.id;
      } catch (err: unknown) {
        if (isAlreadyExistsError(err)) {
          // CF already has a Hyperdrive for this name (orphaned from a prior partial failure).
          // Look up its ID and update it with the submitted connectionString so CF reflects
          // what we're about to store — never persist a URL that CF hasn't accepted.
          try {
            const hd = await getHyperdriveByName(
              context.env.CF_ACCOUNT_ID,
              context.env.CF_API_TOKEN,
              resourceName,
            );
            await updateHyperdrive(
              context.env.CF_ACCOUNT_ID,
              context.env.CF_API_TOKEN,
              hd.id,
              connectionString,
              resourceName,
            );
            hyperdriveId = hd.id;
          } catch (lookupErr: unknown) {
            const response = toDatabaseProvisioningError(lookupErr);
            if (response) {
              return context.json(response.body, response.status);
            }
            throw lookupErr;
          }
        } else {
          const response = toDatabaseProvisioningError(err);
          if (response) {
            return context.json(response.body, response.status);
          }
          throw err;
        }
      }
      await createResource(context.get('db'), projectId, 'hyperdrive', hyperdriveId, 'HYPERDRIVE');
    }

    // CF accepted the connection string — persist it as our cached copy.
    // CF is the source of truth for production routing; this row is the URL
    // that CF accepted and is now serving. If this upsert fails (rare),
    // instruct the user to re-run `void db set-url` to re-sync.
    try {
      const encrypted = await encryptProjectSecret(
        context.env,
        projectId,
        'database-url',
        connectionString,
      );
      await upsertProjectDatabaseUrl(
        context.get('db'),
        projectId,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.keyVersion,
      );
    } catch {
      return context.json(
        {
          error:
            'Failed to persist database URL after Cloudflare accepted it. Run `void db set-url` again to re-sync.',
        },
        500,
      );
    }

    return context.json({ ok: true });
  })

  // Retrieve the stored (encrypted-at-rest) PostgreSQL connection string
  .get('/:id/database-url', async (context) => {
    const projectId = context.req.param('id');
    const project = await getProject(context.get('db'), projectId);
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }

    const row = await getProjectDatabaseUrl(context.get('db'), projectId);
    if (!row) {
      return context.json(
        {
          error: 'database_url_not_stored',
          message:
            "This project's database URL is not stored on the platform yet. Run `void db set-url` once to populate it.",
        },
        404,
      );
    }

    const url = await decryptProjectSecret(context.env, projectId, {
      name: 'database-url',
      ciphertext: row.ciphertext,
      iv: row.iv,
      key_version: row.key_version,
    });
    return context.json({ url });
  });

function parseDuration(input: string): number | null {
  const match = input.match(/^(\d+)(m|h|d)$/);
  if (!match) {
    return null;
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
  const ms = value * multipliers[unit];
  if (ms > 7 * 86_400_000) {
    return null;
  } // cap at 7d
  return ms;
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes('already exists');
}

function getHyperdriveResourceName(projectId: string): string {
  return `${projectId}-hyperdrive`.toLowerCase().replaceAll('_', '-');
}

function toDatabaseProvisioningError(
  error: unknown,
): { body: { detail?: string; error: string }; status: 400 | 502 } | null {
  if (error instanceof CloudflareApiError) {
    return {
      body: {
        error: 'Failed to provision Hyperdrive',
        detail: error.message.replace(/^Cloudflare API error:\s*/, ''),
      },
      status: 502,
    };
  }

  if (error instanceof InvalidHyperdriveConnectionStringError) {
    return {
      body: { error: error.message },
      status: 400,
    };
  }

  return null;
}

function tryParse(json: string): ReadonlyArray<unknown> {
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

export default app;
