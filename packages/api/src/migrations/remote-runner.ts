const CF_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';

export interface RemoteMigration {
  name: string;
  sql: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * drizzle-kit unconditionally emits `--> statement-breakpoint` between
 * every generated statement in a migration (see drizzle-orm's
 * `migrator.js`, which splits on this exact literal at runtime). Its
 * presence in a migration body is a load-bearing declaration that the
 * body is multi-statement — independently of any SQL parsing.
 *
 * The regex is deliberately permissive so future drizzle-kit tweaks
 * (extra dashes, casing, whitespace, `_` / `-` separators) still match
 * and fail safely. A false positive on this check only disables the
 * narrow recovery path — the safe direction — so loosening is fine;
 * tightening would risk silently enabling recovery on a multi-statement
 * body and letting the second statement go un-applied.
 */
const DRIZZLE_STATEMENT_BREAKPOINT = /-{2,}\s*>\s*statement[\s\-_]*breakpoint/i;

/**
 * Returns `true` iff `sql` contains exactly one effective statement.
 *
 * Used to gate the "already exists / duplicate column" recovery path in
 * `runRemoteMigrations`. Only single-statement migrations can safely be
 * marked applied on an `already exists` error — multi-statement bodies
 * may have a half-applied partial commit where the failing statement is
 * NOT the one that already exists, in which case D1 aborts the batch at
 * the first error and later statements never run.
 *
 * Two-tier strategy:
 *
 *   1. **Marker short-circuit.** If `sql` contains drizzle-kit's
 *      `--> statement-breakpoint` marker anywhere, the body is
 *      declared multi-statement by drizzle itself — return `false`
 *      without tokenizing. This is the cheapest and most authoritative
 *      signal we have for the overwhelmingly common drizzle-generated
 *      case, and it is immune to the quote / comment edge cases that
 *      a tokenizer must handle.
 *   2. **Char-by-char tokenizer fallback.** For hand-written or
 *      non-drizzle migrations with no marker, walk the SQL char-by-char
 *      and count statements. A naive "strip comments, split on `;`"
 *      regex pipeline cannot tell the difference between a real
 *      comment / terminator and one that appears inside a quoted
 *      string literal — for example,
 *      `CREATE TABLE t (x TEXT DEFAULT '-- none'); CREATE TABLE u (y)`
 *      would get "stripped" from the first `--` onward and misclassify
 *      as a single statement, masking a multi-statement body whose
 *      second statement would silently be marked applied.
 *
 * The tokenizer honors:
 *   - SQL `--` line comments (skipped only when outside a string literal)
 *   - SQL block comments (skipped only when outside a string literal)
 *   - `'...'` single-quoted string literals with `''` doubled-quote escapes
 *   - `"..."` double-quoted identifiers with `""` doubled-quote escapes
 *
 * It does NOT handle Postgres-specific `$tag$ ... $tag$` dollar-quoting,
 * Postgres `E'...'` extended string literals, or MySQL backtick-quoted
 * identifiers. None of those appear in Drizzle-generated D1 / Postgres
 * migrations today. A misclassification in the "false" direction is
 * safe: the error propagates and the operator reconciles by hand.
 *
 * Edge case, documented: if a hand-written migration embeds the literal
 * string `--> statement-breakpoint` inside a quoted literal (e.g. a
 * seed row), the marker short-circuit will return `false` and the
 * tokenizer is not consulted. That's a safe false-positive: recovery is
 * disabled, the operator sees the underlying error, no data is lost.
 */
export function isSingleStatement(sql: string): boolean {
  // Primary: drizzle-kit marker is authoritative. Present ⇒ multi-statement.
  if (DRIZZLE_STATEMENT_BREAKPOINT.test(sql)) {
    return false;
  }
  // Fallback: walk the SQL char-by-char.
  return isSingleStatementByTokenizer(sql);
}

function isSingleStatementByTokenizer(sql: string): boolean {
  const len = sql.length;
  let i = 0;
  let statements = 0;
  let inStatement = false;

  while (i < len) {
    const c = sql[i];

    // Line comment -- ... (to end of line)
    if (c === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < len && sql[i] !== '\n') {
        i++;
      }
      continue;
    }

    // Block comment /* ... */
    if (c === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i + 1 < len && !(sql[i] === '*' && sql[i + 1] === '/')) {
        i++;
      }
      // Skip the closing */ (or jump past end-of-input if unterminated).
      i += 2;
      continue;
    }

    // Single-quoted string literal. Doubled '' is an escaped inner quote,
    // stay inside.
    if (c === "'") {
      i++;
      while (i < len) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      inStatement = true;
      continue;
    }

    // Double-quoted identifier. Doubled "" is an escaped inner quote,
    // stay inside.
    if (c === '"') {
      i++;
      while (i < len) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      inStatement = true;
      continue;
    }

    // Statement terminator
    if (c === ';') {
      if (inStatement) {
        statements++;
        inStatement = false;
      }
      i++;
      continue;
    }

    // Whitespace alone does not start a statement
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }

    // Any other char is "statement content" — mark that a statement is in
    // progress so an unterminated trailing body still gets counted.
    inStatement = true;
    i++;
  }

  if (inStatement) {
    statements++;
  }
  return statements === 1;
}

/**
 * One-time migration: rename legacy `_migrations` table to `_void_migrations`.
 * Copies all rows from the old table to the new one, then drops the old table.
 */
async function upgradeTrackingTable(
  accountId: string,
  apiToken: string,
  databaseId: string,
): Promise<void> {
  const result = await queryD1(accountId, apiToken, databaseId, {
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'",
  });
  if (!result.results || result.results.length === 0) {
    return;
  }
  // INSERT must succeed — propagate failures so the applied set is complete.
  await queryD1(accountId, apiToken, databaseId, {
    sql: `INSERT OR IGNORE INTO _void_migrations (name, applied_at) SELECT name, applied_at FROM _migrations`,
  });
  // DROP can fail if a concurrent caller already dropped the table — safe to ignore.
  try {
    await queryD1(accountId, apiToken, databaseId, {
      sql: `DROP TABLE _migrations`,
    });
  } catch {
    // Concurrent upgrade already dropped the table
  }
}

/**
 * Run migrations against a remote D1 database via the CF REST API.
 *
 * 1. Ensure _void_migrations tracking table exists
 * 2. Query already-applied migrations
 * 3. For each pending: execute SQL + record in _void_migrations
 */
/**
 * Ensure _void_migrations table exists and upgrade legacy _migrations if present.
 * Returns the set of already-applied migration names.
 */
export async function ensureTrackingTable(
  accountId: string,
  apiToken: string,
  databaseId: string,
): Promise<Set<string>> {
  await queryD1(accountId, apiToken, databaseId, {
    sql: `CREATE TABLE IF NOT EXISTS _void_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,
  });
  await upgradeTrackingTable(accountId, apiToken, databaseId);
  const appliedResult = await queryD1(accountId, apiToken, databaseId, {
    sql: 'SELECT name FROM _void_migrations',
  });
  return new Set(appliedResult.results.map((row) => row.name as string));
}

export async function runRemoteMigrations(
  accountId: string,
  apiToken: string,
  databaseId: string,
  migrations: RemoteMigration[],
  appliedSet?: Set<string>,
): Promise<MigrationResult> {
  const applied = appliedSet ?? (await ensureTrackingTable(accountId, apiToken, databaseId));

  const result: MigrationResult = { applied: [], skipped: [] };

  for (const migration of migrations) {
    if (applied.has(migration.name)) {
      result.skipped.push(migration.name);
      continue;
    }

    // Execute migration SQL, then record the tracking row. The two queries
    // are not atomic (D1 exposes them as separate HTTP requests), so a retry
    // after the SQL committed but before the tracking INSERT landed will
    // re-run the migration against an object that already exists.
    //
    // The narrow recovery below catches exactly that case: if `applied`
    // (populated from `_void_migrations`) does NOT contain this migration,
    // we have never successfully recorded it, so the only way to hit an
    // "already exists" / "duplicate column" error from a fresh run is a
    // prior post-SQL failure (network blip, 429, timeout) that committed
    // the SQL but lost the tracking INSERT. Reconciling via INSERT OR
    // IGNORE is correct in that case and restores the deploy-retry path
    // that void-sdk/void#6 is about.
    //
    // Restriction: the recovery is gated on `isSingleStatement(migration.sql)`.
    // For a multi-statement migration (e.g. `CREATE TABLE a; CREATE INDEX
    // idx ON a(id);`) a mid-migration partial commit is not safely
    // recoverable: if statement 1 committed on a prior deploy and statement
    // 2 failed, the retry re-runs the whole body, D1 aborts the batch at
    // the first "already exists" error (D1 stops at the first statement
    // failure), and we would mark the migration applied even though
    // statement 2 never ran. Propagating the error is the safe direction
    // here — the operator can fix the partial state by hand, and
    // deploy-retry still works for the common single-statement case.
    //
    // Trade-off (single-statement path): this CAN mask a hand-merged
    // schema conflict where two different migrations create the same
    // object. In a drizzle-managed workflow that's extremely unlikely
    // (drizzle-kit guarantees unique object names per snapshot), and the
    // alternative — propagate every such error — breaks deploy retries
    // for every transient network failure, which is the main symptom
    // users hit.
    try {
      await queryD1(accountId, apiToken, databaseId, { sql: migration.sql });
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (!/already exists|duplicate column/i.test(msg) || !isSingleStatement(migration.sql)) {
        throw err;
      }
      // Fall through to the tracking INSERT below — the object already
      // exists on the remote DB and the applied set says we never
      // recorded it, so reconcile by writing the tracking row. Safe only
      // for single-statement migrations (see comment above).
    }

    // INSERT OR IGNORE makes the tracking write idempotent, so a retry that
    // re-runs the same migration (e.g. after a network blip on a previous
    // tracking INSERT) never produces a duplicate tracking row.
    await queryD1(accountId, apiToken, databaseId, {
      sql: 'INSERT OR IGNORE INTO _void_migrations (name, applied_at) VALUES (?, ?)',
      params: [migration.name, new Date().toISOString()],
    });

    result.applied.push(migration.name);
  }

  return result;
}

interface D1Query {
  sql: string;
  params?: unknown[];
}

interface D1QueryResponse {
  results: Record<string, unknown>[];
}

export async function queryD1(
  accountId: string,
  apiToken: string,
  databaseId: string,
  query: D1Query,
): Promise<D1QueryResponse> {
  const url = `${CF_API_BASE}/${accountId}/d1/database/${databaseId}/query`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(query),
  });

  const json = (await response.json()) as {
    success: boolean;
    errors: { code: number; message: string }[];
    result: D1QueryResponse[];
  };

  if (!json.success) {
    const msg = json.errors.map((e) => e.message).join(', ');
    throw new Error(`D1 migration failed: ${msg}`);
  }

  // D1 query API returns an array of results (one per statement)
  return json.result[0] ?? { results: [] };
}
