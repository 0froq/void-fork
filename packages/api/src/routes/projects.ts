import { sql as drizzleSql } from 'drizzle-orm';
import { Hono } from 'hono';
import { hmacSignState } from '../auth/hmac';
import { DEFAULT_DISPATCH_NAMESPACE } from '../constants';
import type { Db } from '../db';
import {
  createProject,
  getProject,
  getProjectBySlug,
  getProjectsByUserId,
  getProjectDeployments,
  getProjectResources,
  getActivatedDeployments,
  getTerminalFailedDeployments,
  getDomainsByProjectId,
  getDomainsByProjectIds,
  getDeployment,
  cancelDeployment,
  setActiveDeployment,
  appendAppliedMigrations,
  activeDeploymentContainsMigration,
  renameAppliedMigrationsForProject,
  recordMigrationRenames,
  migrationRenameExists,
  invalidateMigrationRenamesForOldName,
} from '../db';
import type { ApiEnv } from '../env';
import { ensureTrackingTable, queryD1, runRemoteMigrations } from '../migrations/remote-runner';
import { getProjectDeploymentWorkerName, getProjectQueueName } from '../naming';
import { getDispatchWorkerProxyToken } from '../provisioning/cloudflare-api';
import { buildRoutingJson, buildStaticRoutingJson } from '../routing';
import { tokenizeSql } from '../sql/tokenize';
import { getPlanLimits } from '../tiers';
import type { DeployManifest } from '../types';

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
  //
  //   1. `DELETE FROM <t>` with no WHERE — mass delete; irreversible.
  //   2. `UPDATE <t> SET …` with no WHERE — mass mutation, typically to
  //      NULL; silently corrupts every row in the table.
  //   3. `INSERT OR REPLACE INTO …` — silently deletes any row whose
  //      primary key collides with the insert, dressed up as an insert.
  //
  // The DELETE / UPDATE forms use `(?:(?!\bWHERE\b)[^;])*` to scan to the
  // next statement terminator while asserting that no `WHERE` keyword
  // appears in the span. We treat a `WHERE` ANYWHERE in the statement as
  // "bounded" — intentionally simple: a false negative on
  // `UPDATE a SET b = (SELECT c FROM d WHERE e = 1)` (a WHERE only in a
  // subquery) is acceptable because the pragma remains available to
  // authorize such cases. Trigger-body DML is caught transparently:
  // inside a `BEGIN … END` block the inner `;` acts as a statement
  // terminator for these regexes just as it does at the top level, so an
  // unbounded `DELETE FROM x;` nested in a trigger body matches the outer
  // DELETE pattern without needing a separate parser.
  /\bDELETE\s+FROM\b(?:(?!\bWHERE\b)[^;])*(?:;|$)/i,
  /\bUPDATE\b(?:(?!\bWHERE\b)[^;])*?\bSET\b(?:(?!\bWHERE\b)[^;])*(?:;|$)/i,
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
    public readonly destructiveMigrations?: string[],
  ) {
    super(message);
    this.name = 'RollbackError';
  }
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

interface LineComment {
  text: string;
  standalone: boolean;
}

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
function stripSqlStringsAndComments(sql: string): { code: string; lineComments: LineComment[] } {
  let code = '';
  const lineComments: LineComment[] = [];

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

function hasUnauthorizedDestructive(migrations: { name: string; sql: string }[]): string[] {
  const violations: string[] = [];
  for (const m of migrations) {
    const { code, lineComments } = stripSqlStringsAndComments(m.sql);
    const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(code));
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
  .get('/', async (c) => {
    const userId = c.get('user').id;
    const projects = await getProjectsByUserId(c.get('db'), userId);

    // Batch-fetch domains for all projects in a single query
    const projectIds = projects.map((p) => p.id);
    const domainMap =
      projectIds.length > 0 ? await getDomainsByProjectIds(c.get('db'), projectIds) : new Map();

    const projectsWithDomains = projects.map((p) => {
      const pDomains = domainMap.get(p.id);
      const domain =
        pDomains?.find((d: { status: string }) => d.status === 'active') ?? pDomains?.[0];
      return { ...p, custom_domain: domain?.hostname ?? null };
    });

    return c.json(projectsWithDomains);
  })

  // Create a new project
  .post('/', async (c) => {
    const body = await c.req.json<{ slug: string }>();

    if (!body.slug) {
      return c.json({ error: 'slug is required' }, 400);
    }

    // Validate slug format: lowercase alphanumeric + dashes, no leading/trailing dashes
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(body.slug)) {
      return c.json({ error: 'slug must be lowercase alphanumeric with dashes' }, 400);
    }

    if (RESERVED_SLUGS.has(body.slug)) {
      return c.json({ error: 'this name is reserved' }, 400);
    }

    // Short slugs (5 chars or fewer) are reserved for paid plans
    if (body.slug.length <= 5) {
      if (c.get('user').plan === 'free') {
        return c.json({ error: 'short slugs (5 characters or fewer) require a paid plan' }, 403);
      }
    }

    // Check for slug uniqueness
    const existing = await getProjectBySlug(c.get('db'), body.slug);
    if (existing) {
      return c.json({ error: 'slug already taken' }, 409);
    }

    const userId = c.get('user').id;
    try {
      const project = await createProject(c.get('db'), userId, body.slug);
      return c.json(project, 201);
    } catch (err) {
      // Unique constraint violation — slug was taken between check and insert
      if (
        err instanceof Error &&
        err.message.includes('duplicate key value violates unique constraint')
      ) {
        return c.json({ error: 'slug already taken' }, 409);
      }
      throw err;
    }
  })

  // Get project by ID
  .get('/:id', async (c) => {
    const project = await getProject(c.get('db'), c.req.param('id'));
    if (!project) {
      return c.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== c.get('user').id) {
      return c.json({ error: 'forbidden' }, 403);
    }
    return c.json(project);
  })

  // List deployments for a project
  .get('/:id/deployments', async (c) => {
    const project = await getProject(c.get('db'), c.req.param('id'));
    if (!project) {
      return c.json({ error: 'project not found' }, 404);
    }

    if (project.user_id !== c.get('user').id) {
      return c.json({ error: 'forbidden' }, 403);
    }

    const deployments = await getProjectDeployments(c.get('db'), project.id, 20);
    return c.json({
      deployments,
      activeDeploymentId: project.active_deployment_id,
    });
  })

  // Request cancellation of an active deployment
  .post('/:id/deployments/:deploymentId/cancel', async (c) => {
    const projectId = c.req.param('id');
    const deploymentId = c.req.param('deploymentId');
    const project = await getProject(c.get('db'), projectId);
    if (!project) {
      return c.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== c.get('user').id) {
      return c.json({ error: 'forbidden' }, 403);
    }

    const deployment = await getDeployment(c.get('db'), deploymentId);
    if (!deployment || deployment.project_id !== projectId) {
      return c.json({ error: 'deployment not found' }, 404);
    }

    const canceling = await cancelDeployment(c.get('db'), deploymentId, 'canceled by user');
    if (!canceling) {
      return c.json({ error: 'deployment already completed', status: deployment.status }, 409);
    }

    return c.json({ ok: true, deploymentId, status: 'canceling' });
  })

  // Rollback to a previous deployment
  .post('/:id/rollback', async (c) => {
    const projectId = c.req.param('id');
    const project = await getProject(c.get('db'), projectId);
    if (!project) {
      return c.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== c.get('user').id) {
      return c.json({ error: 'forbidden' }, 403);
    }

    const { deploymentId, allowDestructive } = await c.req.json<{
      deploymentId: string;
      allowDestructive?: string[];
    }>();
    if (!deploymentId) {
      return c.json({ error: 'deploymentId is required' }, 400);
    }
    if (allowDestructive !== undefined) {
      if (!Array.isArray(allowDestructive) || allowDestructive.some((m) => typeof m !== 'string')) {
        return c.json(
          { error: 'allowDestructive must be an array of migration name strings' },
          400,
        );
      }
    }

    // Pre-lock sanity check: reject fast if the deployment plainly does
    // not belong to this project. The authoritative check runs inside
    // the lock below against a freshly-read row.
    const preCheck = await getDeployment(c.get('db'), deploymentId);
    if (!preCheck || preCheck.project_id !== projectId) {
      return c.json({ error: 'deployment not found' }, 404);
    }
    if (!preCheck.retained) {
      return c.json({ error: 'deployment not retained (worker script evicted)' }, 400);
    }

    const planLimits = getPlanLimits(c.get('user').plan);
    const dispatchLimits =
      planLimits.cpuMsPerRequest > 0 || planLimits.subRequestsPerInvocation > 0
        ? {
            ...(planLimits.cpuMsPerRequest > 0 ? { cpuMs: planLimits.cpuMsPerRequest } : {}),
            ...(planLimits.subRequestsPerInvocation > 0
              ? { subRequests: planLimits.subRequestsPerInvocation }
              : {}),
          }
        : null;

    // The entire rollback cutover runs inside a single row-locked tx so
    // concurrent rollbacks / applies / renames serialize and no external
    // state is written before the pg flip. Ordering invariants:
    //
    //   - pg flip runs FIRST inside the lock; external writes run AFTER.
    //     If the pg flip throws, the tx rolls back and no external writes
    //     have happened yet → caller sees 500, state is consistent.
    //
    //   - If an external write throws after the pg flip, the tx rolls
    //     back (reverting active_deployment_id), but some earlier
    //     external writes may have already landed. The caller sees 500
    //     and retries; KV PUTs and cron/queue routes are idempotent
    //     under the same payload.
    //
    // target.applied_migrations (and retained, manifest) are re-read
    // inside the lock because a concurrent /rename can rewrite every
    // deployment's applied_migrations via
    // renameAppliedMigrationsForProject.
    let rollbackResult: { migrationDiff: string[] };
    try {
      rollbackResult = await c.get('db').transaction(async (tx) => {
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

        const targetMigrations: string[] = target.applied_migrations
          ? JSON.parse(target.applied_migrations)
          : [];

        const currentActive = lockedProject.active_deployment_id
          ? await getDeployment(txDb, lockedProject.active_deployment_id)
          : null;
        const currentMigrations: string[] = currentActive?.applied_migrations
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
        const existingRouting = await c.env.ROUTING.get(lockedProject.slug);
        const existingEntry = existingRouting ? JSON.parse(existingRouting) : null;
        const isStaticDeployment = lockedProject.type === 'static' || lockedProject.type === 'spa';

        let routingJson: string;
        if (isStaticDeployment) {
          const assetConfig = manifest?.assetConfig ?? {
            not_found_handling:
              lockedProject.type === 'spa' ? 'single-page-application' : '404-page',
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
          });
        }

        // PG flip FIRST. If this throws, no external state is mutated
        // yet — the tx rolls back cleanly and the caller can retry.
        await setActiveDeployment(txDb, projectId, target.id);

        // External writes SECOND, inside the same lock. A throw here
        // rolls back the pg flip; some external writes may have
        // already landed but subsequent external retries are
        // idempotent (KV PUT is an overwrite; queue/domain routes are
        // keyed by slug/hostname; cron DO sync is a replace).
        await c.env.ROUTING.put(lockedProject.slug, routingJson);

        // Resolve the target worker's baked __VOID_PROXY_TOKEN once if
        // either cron or queues need it. Re-fetching on each path would
        // double the CF API round-trips AND widen the failure window
        // between cron DO sync and queue KV write: a transient CF 429
        // on the second fetch would abort the transaction after cron
        // state was already committed to the DO. The framework's
        // /__void/scheduled and /__void/queue handlers both validate
        // against the SAME __VOID_PROXY_TOKEN binding, so one lookup
        // is authoritative for both.
        const needsProxyToken = !!manifest?.schedules?.length || !!manifest?.queues?.length;
        const targetProxyToken = needsProxyToken
          ? await resolveRollbackProxyToken(c.env, workerName, projectId)
          : null;

        // Sync cron scheduler to point at the rollback target.
        //
        // When target has no schedules, `/clear` is called unconditionally
        // (it's idempotent — see cron-scheduler.ts `handleClear`). A
        // prior failed cutover could leave the DO holding schedules that
        // no pg manifest still mentions, and a guarded clear would let
        // that stale DO state persist across every future rollback.
        if (manifest?.schedules?.length) {
          const cronId = c.env.CRON_SCHEDULER.idFromName(projectId);
          await c.env.CRON_SCHEDULER.get(cronId).fetch(
            new Request('https://do/sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                workerName,
                schedules: manifest.schedules,
                proxyToken: targetProxyToken!,
              }),
            }),
          );
        } else {
          const cronId = c.env.CRON_SCHEDULER.idFromName(projectId);
          await c.env.CRON_SCHEDULER.get(cronId).fetch(
            new Request('https://do/clear', { method: 'POST' }),
          );
        }

        // Update custom domain routing
        const projectDomains = await getDomainsByProjectId(txDb, projectId);
        for (const domain of projectDomains) {
          if (domain.status === 'active') {
            await c.env.ROUTING.put(`domain:${domain.hostname}`, routingJson);
          }
        }

        // Update queue routing. Rewrite every queue route that target
        // binds AND delete any queue route left over from older
        // deployments that target does not bind. Without the deletion
        // pass, messages arriving on a queue A had bound but B does not
        // would still hit `queue:<q>` in KV and dispatch would forward
        // them to A's (now evicted) worker.
        //
        // Sweep source is the UNION of:
        //   - Deployments that have ever been live (`deployed_at IS NOT NULL`).
        //   - Terminal-failed/canceled deployments (`deployed_at = null`).
        //
        // The second set catches deploys that wrote `queue:<name>` KV
        // routes at step 2b and then failed before the routing flip.
        // In-flight deploys (status not in the terminal-failed set) are
        // excluded, so rollback does not clobber KV routes an in-flight
        // deploy is provisioning.
        const [activatedDeployments, terminalFailedDeployments] = await Promise.all([
          getActivatedDeployments(txDb, projectId),
          getTerminalFailedDeployments(txDb, projectId),
        ]);
        const sweepQueueNames = new Set<string>();
        const unionSource = [...activatedDeployments, ...terminalFailedDeployments];
        for (const d of unionSource) {
          if (!d.manifest) {
            continue;
          }
          let depManifest: DeployManifest | null = null;
          try {
            depManifest = JSON.parse(d.manifest);
          } catch {
            // Skip deployments with unparseable manifests rather than
            // blowing up the whole rollback.
            continue;
          }
          for (const q of depManifest?.queues ?? []) {
            sweepQueueNames.add(q.name);
          }
        }
        // Include target's own queue names in the union so the delete
        // pass's complement is always `union \ target`, i.e. we never
        // accidentally delete a route we're about to rewrite below.
        const targetQueueNames = new Set((manifest?.queues ?? []).map((q) => q.name));
        for (const name of targetQueueNames) {
          sweepQueueNames.add(name);
        }
        if (manifest?.queues?.length) {
          for (const q of manifest.queues) {
            await c.env.ROUTING.put(
              `queue:${getProjectQueueName(projectId, q.name)}`,
              JSON.stringify({
                workerName,
                projectId,
                queueName: q.name,
                proxyToken: targetProxyToken!,
              }),
            );
          }
        }
        for (const name of sweepQueueNames) {
          if (targetQueueNames.has(name)) {
            continue;
          }
          await c.env.ROUTING.delete(`queue:${getProjectQueueName(projectId, name)}`);
        }

        return { migrationDiff: diff };
      });
    } catch (err) {
      if (err instanceof RollbackError) {
        if (err.destructiveMigrations) {
          return c.json(
            { error: err.message, destructiveMigrations: err.destructiveMigrations },
            err.status,
          );
        }
        return c.json({ error: err.message }, err.status);
      }
      throw err;
    }

    return c.json({
      ok: true,
      deploymentId,
      migrationDiff: rollbackResult.migrationDiff,
    });
  })

  // Get migration status for a project
  .get('/:id/migrations', async (c) => {
    const project = await getProject(c.get('db'), c.req.param('id'));
    if (!project) {
      return c.json({ error: 'project not found' }, 404);
    }

    if (project.user_id !== c.get('user').id) {
      return c.json({ error: 'forbidden' }, 403);
    }

    const resources = await getProjectResources(c.get('db'), project.id);
    const d1Resource = resources.find((r) => r.type === 'd1');
    if (!d1Resource) {
      return c.json({ applied: [] });
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
      const legacy = await queryD1(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, d1Resource.cf_id, {
        sql: 'SELECT name, applied_at FROM _migrations ORDER BY name',
      });
      for (const r of legacy.results) {
        byName.set(r.name as string, r.applied_at as string);
      }
    } catch (err) {
      if (!isMissingTableError(err)) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    try {
      const result = await queryD1(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, d1Resource.cf_id, {
        sql: 'SELECT name, applied_at FROM _void_migrations ORDER BY name',
      });
      for (const r of result.results) {
        byName.set(r.name as string, r.applied_at as string);
      }
    } catch (err) {
      if (!isMissingTableError(err)) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    const applied = Array.from(byName, ([name, applied_at]) => ({ name, applied_at })).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    return c.json({ applied });
  })

  // Apply migrations to a project's remote D1 database
  .post('/:id/migrations/apply', async (c) => {
    const projectId = c.req.param('id');
    const project = await getProject(c.get('db'), projectId);
    if (!project) {
      return c.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== c.get('user').id) {
      return c.json({ error: 'forbidden' }, 403);
    }

    const body = await c.req.json<{ migrations: { name: string; sql: string }[] }>();
    if (!body.migrations || !Array.isArray(body.migrations)) {
      return c.json({ error: 'migrations array required' }, 400);
    }
    const invalidEntry = body.migrations.find(
      (m) => typeof m.name !== 'string' || !m.name || typeof m.sql !== 'string',
    );
    if (invalidEntry) {
      return c.json(
        { error: 'each migration must have a non-empty string "name" and string "sql"' },
        400,
      );
    }
    const nameSet = new Set<string>();
    for (const m of body.migrations) {
      if (nameSet.has(m.name)) {
        return c.json({ error: `duplicate migration name: ${m.name}` }, 400);
      }
      nameSet.add(m.name);
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
      const outcome = await c.get('db').transaction(async (tx) => {
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
          c.env.CF_ACCOUNT_ID,
          c.env.CF_API_TOKEN,
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
          c.env.CF_ACCOUNT_ID,
          c.env.CF_API_TOKEN,
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
        if (effectiveNames.length > 0 && locked?.active_deployment_id) {
          await appendAppliedMigrations(txDb, locked.active_deployment_id, effectiveNames);
        }

        if (result.failed) {
          return {
            status: 500 as const,
            body: {
              ok: false,
              error: `migration ${result.failed.name} failed: ${result.failed.error}`,
              applied: result.applied,
              skipped: result.skipped,
              failed: result.failed,
            },
          };
        }

        return {
          status: 200 as const,
          body: { ok: true, applied: result.applied, skipped: result.skipped },
        };
      });
      return c.json(outcome.body, outcome.status);
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })

  // Rename migration records in a project's remote D1 database
  .post('/:id/migrations/rename', async (c) => {
    const projectId = c.req.param('id');
    const project = await getProject(c.get('db'), projectId);
    if (!project) {
      return c.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== c.get('user').id) {
      return c.json({ error: 'forbidden' }, 403);
    }

    const body = await c.req.json<{ renames: { from: string; to: string }[] }>();
    if (!body.renames || !Array.isArray(body.renames) || body.renames.length === 0) {
      return c.json({ error: 'renames array required' }, 400);
    }
    const invalidRename = body.renames.find(
      (r) => typeof r.from !== 'string' || !r.from || typeof r.to !== 'string' || !r.to,
    );
    if (invalidRename) {
      return c.json({ error: 'each rename must have non-empty string "from" and "to"' }, 400);
    }

    // Batch-level validation: the remote UPDATEs are non-atomic, so any
    // partial commit on a PK collision leaves `_void_migrations` half-renamed
    // with no automatic rollback. Rejecting ambiguous or self-conflicting
    // batches up front means a clean DB can never hit a collision mid-batch.
    const fromSet = new Set<string>();
    const toSet = new Set<string>();
    for (const { from } of body.renames) {
      if (fromSet.has(from)) {
        return c.json({ error: 'duplicate "from" in rename batch' }, 400);
      }
      fromSet.add(from);
    }
    for (const { to } of body.renames) {
      if (toSet.has(to)) {
        return c.json({ error: 'duplicate "to" in rename batch' }, 400);
      }
      toSet.add(to);
    }
    // Chains and cycles (`a→b, b→c` or `a→b, b→a`) would need two-phase
    // renames across non-atomic D1 calls to avoid a mid-batch PK collision.
    // Rejecting them forces the caller to split the work into separate
    // requests and keeps this handler's execution path strictly linear.
    for (const { to } of body.renames) {
      if (fromSet.has(to)) {
        return c.json(
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
      const outcome = await c.get('db').transaction(async (tx) => {
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
          c.env.CF_ACCOUNT_ID,
          c.env.CF_API_TOKEN,
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
        const missingFrom: string[] = [];
        const collidingTo: string[] = [];
        const effective: { from: string; to: string }[] = [];
        const alreadyLanded: { from: string; to: string }[] = [];
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
        const committed: { from: string; to: string }[] = [...alreadyLanded];
        type PairFailure =
          | { kind: 'conflict'; from: string; to: string }
          | { kind: 'error'; from: string; to: string; error: string };
        let pairFailure: PairFailure | undefined;
        for (const { from, to } of effective) {
          let update: Awaited<ReturnType<typeof queryD1>>;
          try {
            update = await queryD1(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, d1Resource.cf_id, {
              sql: 'UPDATE _void_migrations SET name = ? WHERE name = ?',
              params: [to, from],
            });
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
            recheck = await queryD1(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, d1Resource.cf_id, {
              sql: 'SELECT name FROM _void_migrations WHERE name = ? OR name = ?',
              params: [from, to],
            });
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
      return c.json(outcome.body, outcome.status);
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })

  // List resources for a project
  .get('/:id/resources', async (c) => {
    const project = await getProject(c.get('db'), c.req.param('id'));
    if (!project) {
      return c.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== c.get('user').id) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const resources = await getProjectResources(c.get('db'), project.id);
    return c.json(resources);
  })

  // Fetch logs for a project
  .get('/:id/logs', async (c) => {
    const project = await getProject(c.get('db'), c.req.param('id'));
    if (!project) {
      return c.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== c.get('user').id) {
      return c.json({ error: 'forbidden' }, 403);
    }

    const since = c.req.query('since') ?? '1h';
    const sinceMs = parseDuration(since);
    if (sinceMs === null) {
      return c.json({ error: 'invalid since parameter, use format like 15m, 2h, 3d' }, 400);
    }

    const limit = Math.min(parseInt(c.req.query('limit') ?? '200', 10) || 200, 500);
    const deploymentId = c.req.query('deploymentId');
    if (deploymentId && !/^dpl_[0-9a-z]+$/.test(deploymentId)) {
      return c.json({ error: 'invalid deploymentId format' }, 400);
    }
    const workerName = `user-${project.slug}`;
    const sinceStr = new Date(Date.now() - sinceMs).toISOString().replace('T', ' ').slice(0, 19);
    const dataset = c.env.LOGS_DATASET ?? 'void_logs';

    const deployFilter = deploymentId ? `\n        AND blob7 = '${deploymentId}'` : '';
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
        AND timestamp >= toDateTime('${sinceStr}')${deployFilter}
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `;

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/analytics_engine/sql`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${c.env.CF_API_TOKEN}`,
          'Content-Type': 'text/plain',
        },
        body: query,
      },
    );

    if (!response.ok) {
      const detail = await response.text();
      console.error(
        `[logs] query failed for project ${project.id} (${response.status}): ${detail.slice(0, 500)}`,
      );
      return c.json({ error: 'log query failed', status: response.status, detail }, 502);
    }

    const result = (await response.json()) as {
      data: {
        outcome: string;
        logData: string;
        exceptionData: string;
        url: string;
        method: string;
        statusCode: string;
        ts: number;
      }[];
    };

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

    return c.json({ data });
  })

  // Provision Hyperdrive for a PostgreSQL project
  .post('/:id/database', async (c) => {
    const projectId = c.req.param('id');
    const project = await getProject(c.get('db'), projectId);
    if (!project || project.user_id !== c.get('user').id) {
      return c.json({ error: 'Not found' }, 404);
    }

    const { connectionString } = await c.req.json<{ connectionString: string }>();
    if (!connectionString?.startsWith('postgres')) {
      return c.json({ error: 'Invalid connection string' }, 400);
    }

    const { createHyperdrive, getHyperdriveByName } =
      await import('../provisioning/cloudflare-api');
    const { createResource, getProjectResources } = await import('../db');

    // Check if Hyperdrive already exists
    const existing = await getProjectResources(c.get('db'), projectId);
    const found = existing.find((r) => r.type === 'hyperdrive');
    if (found) {
      return c.json(
        { error: 'Hyperdrive already provisioned. Use PUT /database-url to update.' },
        409,
      );
    }

    const resourceName = `${projectId}-hyperdrive`.toLowerCase();
    let hyperdriveId: string;
    try {
      const hd = await createHyperdrive(
        c.env.CF_ACCOUNT_ID,
        c.env.CF_API_TOKEN,
        resourceName,
        connectionString,
      );
      hyperdriveId = hd.id;
    } catch (err: any) {
      if (err.message?.toLowerCase().includes('already exists')) {
        const hd = await getHyperdriveByName(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, resourceName);
        hyperdriveId = hd.id;
      } else {
        throw err;
      }
    }

    await createResource(c.get('db'), projectId, 'hyperdrive', hyperdriveId, 'HYPERDRIVE');
    return c.json({ ok: true });
  })

  // Update PostgreSQL connection string (updates Hyperdrive config)
  .put('/:id/database-url', async (c) => {
    const projectId = c.req.param('id');
    const project = await getProject(c.get('db'), projectId);
    if (!project || project.user_id !== c.get('user').id) {
      return c.json({ error: 'Not found' }, 404);
    }

    const { connectionString } = await c.req.json<{ connectionString: string }>();
    if (!connectionString?.startsWith('postgres')) {
      return c.json({ error: 'Invalid connection string' }, 400);
    }

    const { createHyperdrive, updateHyperdrive, getHyperdriveByName } =
      await import('../provisioning/cloudflare-api');
    const { createResource, getProjectResources } = await import('../db');

    const existing = await getProjectResources(c.get('db'), projectId);
    const found = existing.find((r) => r.type === 'hyperdrive');

    if (found) {
      // Update existing Hyperdrive config
      await updateHyperdrive(
        c.env.CF_ACCOUNT_ID,
        c.env.CF_API_TOKEN,
        found.cf_id,
        connectionString,
      );
    } else {
      // Create new Hyperdrive config
      const resourceName = `${projectId}-hyperdrive`.toLowerCase();
      let hyperdriveId: string;
      try {
        const hd = await createHyperdrive(
          c.env.CF_ACCOUNT_ID,
          c.env.CF_API_TOKEN,
          resourceName,
          connectionString,
        );
        hyperdriveId = hd.id;
      } catch (err: any) {
        if (err.message?.toLowerCase().includes('already exists')) {
          const hd = await getHyperdriveByName(
            c.env.CF_ACCOUNT_ID,
            c.env.CF_API_TOKEN,
            resourceName,
          );
          hyperdriveId = hd.id;
        } else {
          throw err;
        }
      }
      await createResource(c.get('db'), projectId, 'hyperdrive', hyperdriveId, 'HYPERDRIVE');
    }

    return c.json({ ok: true });
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

function tryParse(json: string): unknown[] {
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

export default app;
