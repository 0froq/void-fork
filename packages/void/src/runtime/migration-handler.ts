export type MigrationEntry = {
  name: string;
  sql: string;
};

export type MigrationResult = {
  name: string;
  applied: boolean;
  durationMs: number;
  error?: string;
};

export type MigrationResponse = {
  ok: boolean;
  migrations: Array<MigrationResult>;
  error?: string;
};

export function createMigrationHandler(
  env: Record<string, unknown>,
  migrations: Array<MigrationEntry> | undefined,
  _dialect: 'sqlite' | 'postgresql',
  runAuthMigrations?: () => Promise<void>,
) {
  return async (request: Request): Promise<Response> => {
    const token = request.headers.get('x-void-internal');
    if (!token || token !== (env as Record<string, string>).__VOID_PROXY_TOKEN) {
      return Response.json(
        { ok: false, error: 'unauthorized', migrations: [] } satisfies MigrationResponse,
        {
          status: 401,
        },
      );
    }

    try {
      const db = (env as Record<string, D1Database>).DB;
      if (!db) {
        return Response.json(
          { ok: false, error: 'no D1 binding found', migrations: [] } satisfies MigrationResponse,
          { status: 500 },
        );
      }
      const result = await runD1Migrations(db, migrations ?? []);
      if (result.ok && runAuthMigrations) {
        await runAuthMigrations();
      }
      return Response.json(result);
    } catch (err) {
      return Response.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          migrations: [],
        } satisfies MigrationResponse,
        { status: 500 },
      );
    }
  };
}

/**
 * One-time migration: rename legacy `_migrations` table to `_void_migrations`.
 * Copies all rows from the old table to the new one, then drops the old table.
 */
async function upgradeTrackingTable(db: D1Database): Promise<void> {
  const { results } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
    .all();
  if (!results || results.length === 0) {
    return;
  }
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS _void_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`,
    ),
    db.prepare(
      `INSERT OR IGNORE INTO _void_migrations (name, applied_at) SELECT name, applied_at FROM _migrations`,
    ),
    db.prepare(`DROP TABLE _migrations`),
  ]);
}

async function runD1Migrations(
  db: D1Database,
  migrations: Array<MigrationEntry>,
): Promise<MigrationResponse> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS _void_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,
    )
    .run();

  // Upgrade legacy `_migrations` table if it exists
  await upgradeTrackingTable(db);

  const { results } = await db.prepare('SELECT name FROM _void_migrations').all();
  const applied = new Set((results ?? []).map((r) => r.name as string));

  const migrationResults: Array<MigrationResult> = [];

  for (const m of migrations) {
    if (applied.has(m.name)) {
      migrationResults.push({ name: m.name, applied: false, durationMs: 0 });
      continue;
    }

    const start = Date.now();
    try {
      const statements = splitMigrationSql(m.sql);
      if (statements.length === 1 && statements[0] === m.sql) {
        await db.exec(m.sql);
      } else {
        for (const statement of statements) {
          await db.prepare(statement).run();
        }
      }
      await db
        .prepare('INSERT OR IGNORE INTO _void_migrations (name, applied_at) VALUES (?, ?)')
        .bind(m.name, new Date().toISOString())
        .run();
      migrationResults.push({ name: m.name, applied: true, durationMs: Date.now() - start });
    } catch (err) {
      migrationResults.push({
        name: m.name,
        applied: false,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, migrations: migrationResults, error: `migration ${m.name} failed` };
    }
  }

  return { ok: true, migrations: migrationResults };
}

function splitMigrationSql(sql: string): Array<string> {
  const lines = sql.split(/\r?\n/);
  if (
    !lines.some((line) => isStatementBreakpointLine(line) || hasInlineStatementBreakpoint(line))
  ) {
    return [sql];
  }

  const statements: Array<string> = [];
  const current: Array<string> = [];

  for (const line of lines) {
    if (isStatementBreakpointLine(line)) {
      const statement = current.join('\n').trim();
      if (statement) {
        statements.push(statement);
      }
      current.length = 0;
      continue;
    }

    if (hasInlineStatementBreakpoint(line)) {
      current.push(line.replace(/-->\s*statement-breakpoint\s*$/, ''));
      const statement = current.join('\n').trim();
      if (statement) {
        statements.push(statement);
      }
      current.length = 0;
      continue;
    }

    current.push(line);
  }

  const statement = current.join('\n').trim();
  if (statement) {
    statements.push(statement);
  }

  return statements.length > 0 ? statements : [sql];
}

function isStatementBreakpointLine(line: string): boolean {
  return line.trim() === '--> statement-breakpoint';
}

function hasInlineStatementBreakpoint(line: string): boolean {
  return /;\s*-->\s*statement-breakpoint\s*$/.test(line.trim());
}
