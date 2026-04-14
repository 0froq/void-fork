import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runRemoteMigrations, isSingleStatement } from '../../src/migrations/remote-runner';

const ACCOUNT_ID = 'test-account';
const API_TOKEN = 'test-token';
const DATABASE_ID = 'd1-uuid-123';

// Track all queries made to D1
let queries: { sql: string; params?: unknown[] }[] = [];

// Applied migrations state (simulates _void_migrations table)
let appliedMigrations: string[] = [];

// Whether the legacy `_migrations` table exists (for upgrade tests)
let hasLegacyTable = false;
let legacyMigrations: string[] = [];

// SQL strings that should trigger a failure response. Map from a substring
// match (or regex) to the error message to return.
let failingSql: { match: string | RegExp; message: string }[] = [];

beforeEach(() => {
  queries = [];
  appliedMigrations = [];
  hasLegacyTable = false;
  legacyMigrations = [];
  failingSql = [];
  vi.restoreAllMocks();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { sql: string; params?: unknown[] };
      queries.push(body);

      const failure = failingSql.find((f) =>
        typeof f.match === 'string' ? body.sql?.includes(f.match) : f.match.test(body.sql ?? ''),
      );
      if (failure) {
        return new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 1000, message: failure.message }],
            result: [],
          }),
        );
      }

      // Tracking INSERT from runRemoteMigrations uses INSERT OR IGNORE ... VALUES.
      // Distinguish from the legacy upgrade path, which uses FROM _migrations.
      if (
        body.sql?.startsWith('INSERT OR IGNORE INTO _void_migrations') &&
        body.sql?.includes('VALUES')
      ) {
        if (!appliedMigrations.includes(body.params![0] as string)) {
          appliedMigrations.push(body.params![0] as string);
        }
      }

      if (body.sql === 'SELECT name FROM _void_migrations') {
        return new Response(
          JSON.stringify({
            success: true,
            errors: [],
            result: [{ results: appliedMigrations.map((name) => ({ name })) }],
          }),
        );
      }

      // sqlite_master check for legacy table
      if (body.sql?.includes('sqlite_master') && body.sql?.includes("'_migrations'")) {
        return new Response(
          JSON.stringify({
            success: true,
            errors: [],
            result: [
              {
                results: hasLegacyTable ? [{ name: '_migrations' }] : [],
              },
            ],
          }),
        );
      }

      // INSERT OR IGNORE from legacy table — simulate copying rows
      if (
        body.sql?.includes('INSERT OR IGNORE INTO _void_migrations') &&
        body.sql?.includes('FROM _migrations')
      ) {
        appliedMigrations.push(...legacyMigrations);
        return new Response(
          JSON.stringify({
            success: true,
            errors: [],
            result: [{ results: [] }],
          }),
        );
      }

      // DROP TABLE _migrations
      if (body.sql?.includes('DROP TABLE _migrations')) {
        hasLegacyTable = false;
        legacyMigrations = [];
        return new Response(
          JSON.stringify({
            success: true,
            errors: [],
            result: [{ results: [] }],
          }),
        );
      }

      // Default success response
      return new Response(
        JSON.stringify({
          success: true,
          errors: [],
          result: [{ results: [] }],
        }),
      );
    }),
  );
});

describe('runRemoteMigrations', () => {
  it('creates _void_migrations table, checks for legacy table, and queries applied', async () => {
    await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, []);

    expect(queries[0]).toEqual(
      expect.objectContaining({
        sql: expect.stringContaining('CREATE TABLE IF NOT EXISTS _void_migrations'),
      }),
    );
    // Upgrade check: query sqlite_master for legacy _migrations table
    expect(queries[1]).toEqual(
      expect.objectContaining({
        sql: expect.stringContaining('sqlite_master'),
      }),
    );
    expect(queries[2]).toEqual(
      expect.objectContaining({ sql: 'SELECT name FROM _void_migrations' }),
    );
  });

  it('applies pending migrations as individual queries', async () => {
    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '001_create.sql', sql: 'CREATE TABLE users (id TEXT);' },
    ]);

    expect(result.applied).toEqual(['001_create.sql']);
    expect(result.skipped).toEqual([]);
    // Should have: CREATE TABLE, sqlite_master check, SELECT, migration SQL, INSERT
    expect(queries).toHaveLength(5);
    expect(queries[3].sql).toBe('CREATE TABLE users (id TEXT);');
    expect(queries[4].sql).toContain('INSERT OR IGNORE INTO _void_migrations');
    expect(queries[4].params![0]).toBe('001_create.sql');
  });

  it('skips already-applied migrations', async () => {
    appliedMigrations = ['001_create.sql'];

    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '001_create.sql', sql: 'CREATE TABLE users (id TEXT);' },
      { name: '002_add_col.sql', sql: 'ALTER TABLE users ADD COLUMN name TEXT;' },
    ]);

    expect(result.skipped).toEqual(['001_create.sql']);
    expect(result.applied).toEqual(['002_add_col.sql']);
  });

  it('applies multiple pending migrations in order', async () => {
    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '001_create.sql', sql: 'CREATE TABLE a;' },
      { name: '002_more.sql', sql: 'CREATE TABLE b;' },
    ]);

    expect(result.applied).toEqual(['001_create.sql', '002_more.sql']);
    // CREATE TABLE IF NOT EXISTS, sqlite_master check, SELECT, SQL1, INSERT1, SQL2, INSERT2
    expect(queries).toHaveLength(7);
    expect(queries[3].sql).toBe('CREATE TABLE a;');
    expect(queries[4].sql).toContain('INSERT OR IGNORE INTO _void_migrations');
    expect(queries[5].sql).toBe('CREATE TABLE b;');
    expect(queries[6].sql).toContain('INSERT OR IGNORE INTO _void_migrations');
  });

  it('handles empty migrations list', async () => {
    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, []);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('throws on D1 API error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              errors: [{ code: 1000, message: 'database not found' }],
              result: [],
            }),
          ),
      ),
    );

    await expect(
      runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
        { name: '001.sql', sql: 'CREATE TABLE x;' },
      ]),
    ).rejects.toThrow('D1 migration failed');
  });

  it('sends correct URL with account and database ID', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, []);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain(`/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`);
  });

  it('upgrades legacy _migrations table to _void_migrations', async () => {
    hasLegacyTable = true;
    legacyMigrations = ['001_create.sql', '002_add_col.sql'];

    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '001_create.sql', sql: 'CREATE TABLE users (id TEXT);' },
      { name: '002_add_col.sql', sql: 'ALTER TABLE users ADD COLUMN name TEXT;' },
      { name: '003_new.sql', sql: 'CREATE TABLE posts (id TEXT);' },
    ]);

    // Legacy migrations should be copied, so 001 and 002 are skipped
    expect(result.skipped).toEqual(['001_create.sql', '002_add_col.sql']);
    expect(result.applied).toEqual(['003_new.sql']);

    // Verify upgrade queries were issued:
    // 1. CREATE TABLE IF NOT EXISTS _void_migrations
    // 2. SELECT from sqlite_master for _migrations
    // 3. INSERT OR IGNORE ... FROM _migrations
    // 4. DROP TABLE _migrations
    const sqlList = queries.map((q) => q.sql);
    expect(sqlList).toContainEqual(expect.stringContaining('SELECT name FROM sqlite_master'));
    expect(sqlList).toContainEqual(
      expect.stringContaining('INSERT OR IGNORE INTO _void_migrations'),
    );
    expect(sqlList).toContainEqual(expect.stringContaining('DROP TABLE _migrations'));
  });

  it('skips upgrade when no legacy _migrations table exists', async () => {
    hasLegacyTable = false;

    await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, []);

    // Should query sqlite_master but NOT issue INSERT OR IGNORE / DROP from
    // a legacy upgrade. The mock distinguishes the two INSERT OR IGNORE shapes
    // by checking for FROM _migrations.
    const sqlList = queries.map((q) => q.sql);
    expect(sqlList).toContainEqual(expect.stringContaining('SELECT name FROM sqlite_master'));
    expect(sqlList.some((sql) => typeof sql === 'string' && sql.includes('FROM _migrations'))).toBe(
      false,
    );
    expect(sqlList).not.toContainEqual(expect.stringContaining('DROP TABLE _migrations'));
  });

  it('recovers from "already exists" when the tracking row was lost on a prior run', async () => {
    // Simulates void-sdk/void#6: a previous deploy committed the user SQL
    // to D1 but the subsequent tracking INSERT failed (network blip, 429,
    // timeout). A retry re-runs the migration, which now fails with
    // "already exists". Because the applied set (populated from
    // _void_migrations) does NOT contain this migration, runRemoteMigrations
    // reconciles by writing the tracking row and marking it applied.
    failingSql = [
      { match: 'CREATE TABLE users (id TEXT);', message: 'table users already exists' },
    ];

    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '001_create.sql', sql: 'CREATE TABLE users (id TEXT);' },
    ]);

    expect(result.applied).toEqual(['001_create.sql']);
    expect(result.skipped).toEqual([]);
    // Tracking row was written even though the SQL call threw.
    expect(appliedMigrations).toContain('001_create.sql');
    // The tracking INSERT was still issued.
    const trackingInserts = queries.filter(
      (q) =>
        typeof q.sql === 'string' &&
        q.sql.startsWith('INSERT OR IGNORE INTO _void_migrations') &&
        q.sql.includes('VALUES'),
    );
    expect(trackingInserts).toHaveLength(1);
    expect(trackingInserts[0].params![0]).toBe('001_create.sql');
  });

  it('recovers from "duplicate column" when the tracking row was lost', async () => {
    failingSql = [
      {
        match: 'ALTER TABLE users ADD COLUMN name TEXT;',
        message: 'duplicate column name: name',
      },
    ];

    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '002_add_col.sql', sql: 'ALTER TABLE users ADD COLUMN name TEXT;' },
    ]);

    expect(result.applied).toEqual(['002_add_col.sql']);
    expect(appliedMigrations).toContain('002_add_col.sql');
  });

  it('does NOT recover when the migration is already in the applied set', async () => {
    // When the tracking row exists, the migration is skipped entirely
    // BEFORE the SQL call runs — the recovery path is never reached, and
    // no SQL queries are issued for this migration.
    appliedMigrations = ['001_create.sql'];
    failingSql = [
      { match: 'CREATE TABLE users (id TEXT);', message: 'table users already exists' },
    ];

    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '001_create.sql', sql: 'CREATE TABLE users (id TEXT);' },
    ]);

    expect(result.skipped).toEqual(['001_create.sql']);
    expect(result.applied).toEqual([]);
    // The migration SQL was never issued — the skip happened before the
    // try/catch around queryD1.
    const migrationSqlCalls = queries.filter((q) => q.sql === 'CREATE TABLE users (id TEXT);');
    expect(migrationSqlCalls).toHaveLength(0);
  });

  it('propagates unrelated errors (syntax error) instead of recovering', async () => {
    // Only "already exists" / "duplicate column" triggers the narrow
    // recovery. A syntax error means the migration is broken — fail loud.
    failingSql = [{ match: 'CREATE TABEL', message: 'syntax error near "TABEL"' }];

    await expect(
      runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
        { name: '001_bad.sql', sql: 'CREATE TABEL oops (id TEXT);' },
      ]),
    ).rejects.toThrow('syntax error');

    // Tracking row must NOT be written for the failed migration.
    expect(appliedMigrations).not.toContain('001_bad.sql');
  });

  it('propagates "already exists" for multi-statement migrations (not safe to recover)', async () => {
    // Multi-statement migrations CANNOT safely fall through the recovery
    // path. Consider `CREATE TABLE a; CREATE INDEX idx ON a(id);` where
    // statement 1 committed on a prior deploy and statement 2 failed
    // (network blip). The retry re-runs the whole body, D1 aborts at the
    // first "already exists" error on statement 1, and marking the
    // migration applied would permanently skip statement 2 — the index
    // would never get created. Propagate the error instead and leave the
    // tracking row unwritten so the operator can reconcile by hand.
    const multiSql = 'CREATE TABLE a (id TEXT); CREATE INDEX idx_a ON a(id);';
    failingSql = [{ match: 'CREATE TABLE a', message: 'table a already exists' }];

    await expect(
      runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
        { name: '001_multi.sql', sql: multiSql },
      ]),
    ).rejects.toThrow(/already exists/);

    // Tracking row must NOT be written for a migration we refused to recover.
    expect(appliedMigrations).not.toContain('001_multi.sql');
    // Tracking INSERT (the VALUES form from runRemoteMigrations) must not
    // have been issued for this migration.
    const trackingInserts = queries.filter(
      (q) =>
        typeof q.sql === 'string' &&
        q.sql.startsWith('INSERT OR IGNORE INTO _void_migrations') &&
        q.sql.includes('VALUES'),
    );
    expect(trackingInserts).toHaveLength(0);
  });

  it('propagates "already exists" when -- inside a quoted literal masks a second statement', async () => {
    // Direct regression for the Codex finding. A multi-statement migration
    // whose first statement defaults a column to a string containing `--`
    // used to be misclassified as single-statement by the regex-based
    // stripper, which meant the "already exists" recovery path would
    // silently mark the whole migration applied — leaving the second
    // CREATE TABLE missing from the remote schema forever. With the
    // tokenizer, isSingleStatement correctly reports multi, the recovery
    // path is skipped, and the error propagates.
    const multiSql = "CREATE TABLE t (x TEXT DEFAULT '-- none'); CREATE TABLE u (y TEXT);";
    failingSql = [{ match: 'CREATE TABLE t', message: 'table t already exists' }];

    await expect(
      runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
        { name: '001_quoted_comment.sql', sql: multiSql },
      ]),
    ).rejects.toThrow(/already exists/);

    // Tracking row must NOT be written — the tokenizer correctly
    // refused to reconcile a multi-statement body.
    expect(appliedMigrations).not.toContain('001_quoted_comment.sql');
    const trackingInserts = queries.filter(
      (q) =>
        typeof q.sql === 'string' &&
        q.sql.startsWith('INSERT OR IGNORE INTO _void_migrations') &&
        q.sql.includes('VALUES'),
    );
    expect(trackingInserts).toHaveLength(0);
  });

  it('tracking INSERT OR IGNORE is idempotent across retries', async () => {
    // Simulates a retry where the user SQL has already committed to D1 via
    // a prior request (so running the migration a second time succeeds) and
    // the tracking row may or may not exist. Since the mock is forgiving
    // (no stateful "already exists" here), we replay the same migration
    // twice against a fresh mock and assert exactly one tracking row ends
    // up in the simulated _void_migrations.
    await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '001_create.sql', sql: 'CREATE TABLE users (id TEXT);' },
    ]);

    // Re-run: the applied set now contains the migration, so it's skipped
    // entirely and no additional tracking write is attempted.
    queries = [];
    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '001_create.sql', sql: 'CREATE TABLE users (id TEXT);' },
    ]);

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(['001_create.sql']);
    expect(appliedMigrations.filter((n) => n === '001_create.sql')).toHaveLength(1);

    // Even if the SAME RUN were to call the tracking INSERT twice with the
    // same name (e.g. a retry loop higher up), the mock simulates
    // INSERT OR IGNORE idempotency — duplicate rows are not appended.
    await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: '001_create.sql', sql: 'CREATE TABLE users (id TEXT);' },
    ]);
    expect(appliedMigrations.filter((n) => n === '001_create.sql')).toHaveLength(1);
  });
});

describe('isSingleStatement', () => {
  it('treats a single statement with trailing semicolon as single', () => {
    expect(isSingleStatement('CREATE TABLE a (id TEXT);')).toBe(true);
  });

  it('treats a single statement without trailing semicolon as single', () => {
    expect(isSingleStatement('CREATE TABLE a (id TEXT)')).toBe(true);
  });

  it('ignores a trailing SQL line comment', () => {
    expect(isSingleStatement('CREATE TABLE a (id TEXT); -- trailing comment')).toBe(true);
  });

  it('treats two SQL statements separated by a semicolon as multi', () => {
    expect(isSingleStatement('CREATE TABLE a (id TEXT); CREATE INDEX b ON a(id);')).toBe(false);
  });

  it('ignores a leading SQL line comment', () => {
    expect(isSingleStatement('-- leading comment\nCREATE TABLE a (id TEXT);')).toBe(true);
  });

  it('ignores a leading SQL block comment', () => {
    expect(isSingleStatement('/* block */\nCREATE TABLE a (id TEXT);')).toBe(true);
  });

  it('ignores a block comment that contains a semicolon', () => {
    // The `;` inside the block comment is stripped before counting, so
    // this remains a single statement.
    expect(isSingleStatement('/* has ; inside */\nCREATE TABLE a (id TEXT);')).toBe(true);
  });

  it('returns false for empty / whitespace-only / comment-only sql', () => {
    // No effective statements — not "single", so recovery stays disabled.
    expect(isSingleStatement('')).toBe(false);
    expect(isSingleStatement('   \n  ')).toBe(false);
    expect(isSingleStatement('-- only a comment\n')).toBe(false);
    expect(isSingleStatement('/* only a block */')).toBe(false);
  });

  it('treats three statements as multi', () => {
    expect(
      isSingleStatement(
        'CREATE TABLE a (id TEXT); CREATE TABLE b (id TEXT); CREATE INDEX c ON a(id);',
      ),
    ).toBe(false);
  });

  it('-- inside a string literal is not a comment (single-statement)', () => {
    // Regression: the previous regex-based stripper turned `--` inside a
    // quoted literal into a line comment, potentially swallowing the rest
    // of the file. The tokenizer must leave the literal alone.
    expect(isSingleStatement("CREATE TABLE t (x TEXT DEFAULT '-- none');")).toBe(true);
  });

  it('-- inside a string literal does not mask a second statement', () => {
    // This is the exact bug Codex caught. The previous implementation
    // would strip everything from the first `--` onward (including the
    // closing quote and the second statement), leaving a single fragment
    // that parsed as "1 statement". The tokenizer must count both.
    expect(
      isSingleStatement("CREATE TABLE t (x TEXT DEFAULT '-- none'); CREATE TABLE u (y TEXT);"),
    ).toBe(false);
  });

  it('; inside a string literal is not a statement terminator', () => {
    expect(isSingleStatement("INSERT INTO t VALUES ('a;b');")).toBe(true);
  });

  it('; inside a double-quoted identifier is not a terminator', () => {
    expect(isSingleStatement('INSERT INTO "weird;name" (x) VALUES (1);')).toBe(true);
  });

  it('doubled single-quote escape stays inside the literal', () => {
    // `''` is an escaped inner single quote — the literal keeps running.
    expect(isSingleStatement("INSERT INTO t VALUES ('O''Brien');")).toBe(true);
  });

  it('doubled double-quote escape stays inside the identifier', () => {
    // `""` is an escaped inner double quote — the identifier keeps running.
    expect(isSingleStatement('INSERT INTO "weird""name" (x) VALUES (1);')).toBe(true);
  });

  describe('drizzle-kit statement-breakpoint marker (primary gate)', () => {
    it('exact drizzle format is detected as multi-statement', () => {
      const sql = [
        'CREATE TABLE a (id TEXT);',
        '--> statement-breakpoint',
        'CREATE TABLE b (id TEXT);',
      ].join('\n');
      expect(isSingleStatement(sql)).toBe(false);
    });

    it('marker with extra whitespace is detected', () => {
      const sql = [
        'CREATE TABLE a (id TEXT);',
        '--   >   statement-breakpoint',
        'CREATE TABLE b (id TEXT);',
      ].join('\n');
      expect(isSingleStatement(sql)).toBe(false);
    });

    it('marker with extra dashes is detected', () => {
      const sql = [
        'CREATE TABLE a (id TEXT);',
        '-----> statement-breakpoint',
        'CREATE TABLE b (id TEXT);',
      ].join('\n');
      expect(isSingleStatement(sql)).toBe(false);
    });

    it('marker with uppercase is detected', () => {
      const sql = [
        'CREATE TABLE a (id TEXT);',
        '--> STATEMENT-BREAKPOINT',
        'CREATE TABLE b (id TEXT);',
      ].join('\n');
      expect(isSingleStatement(sql)).toBe(false);
    });

    it('marker with underscore separator is detected', () => {
      const sql = [
        'CREATE TABLE a (id TEXT);',
        '--> statement_breakpoint',
        'CREATE TABLE b (id TEXT);',
      ].join('\n');
      expect(isSingleStatement(sql)).toBe(false);
    });

    it('marker with no space between statement and breakpoint is detected', () => {
      // Regression guard: `[\s\-_]*` covers zero-width so `statementbreakpoint`
      // (hypothetical tighter drizzle format) is still caught.
      const sql = [
        'CREATE TABLE a (id TEXT);',
        '-->statementbreakpoint',
        'CREATE TABLE b (id TEXT);',
      ].join('\n');
      expect(isSingleStatement(sql)).toBe(false);
    });

    it('marker short-circuits even when the body parses as one statement', () => {
      // The tokenizer alone would see a single `CREATE TABLE` fragment here
      // (the second line is all comment), but the drizzle marker is a
      // declaration that there are more statements to come — trust it.
      const sql = 'CREATE TABLE a (id TEXT); --> statement-breakpoint';
      expect(isSingleStatement(sql)).toBe(false);
    });

    it('drizzle-shaped multi-table migration is detected as multi-statement', () => {
      // Shape of a real drizzle-kit output from our fixtures.
      const sql = [
        'CREATE TABLE `posts` (',
        '\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,',
        '\t`title` text NOT NULL',
        ');',
        '--> statement-breakpoint',
        'CREATE TABLE `users` (',
        '\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,',
        '\t`name` text NOT NULL',
        ');',
      ].join('\n');
      expect(isSingleStatement(sql)).toBe(false);
    });

    it('single-statement drizzle migration (no marker) falls through to tokenizer', () => {
      // A drizzle-kit migration for a single table has no marker — the
      // tokenizer must still recognize it as a single statement.
      const sql = [
        'CREATE TABLE `posts` (',
        '\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,',
        '\t`title` text NOT NULL',
        ');',
      ].join('\n');
      expect(isSingleStatement(sql)).toBe(true);
    });

    it('marker embedded in a quoted literal is a safe false-positive', () => {
      // The marker regex runs before tokenization, so a literal string
      // containing `--> statement-breakpoint` inside quotes will be
      // detected as if it were a real marker. This is intentional: the
      // only consequence is that recovery is disabled for this migration,
      // which is the safe direction. Documented in `isSingleStatement`'s
      // docstring and guarded by this test so a future "smarter" check
      // that breaks the safety direction fails loudly.
      const sql = "INSERT INTO t VALUES ('--> statement-breakpoint');";
      expect(isSingleStatement(sql)).toBe(false);
    });
  });
});
