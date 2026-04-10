import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runRemoteMigrations } from '../../src/migrations/remote-runner';

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

beforeEach(() => {
  queries = [];
  appliedMigrations = [];
  hasLegacyTable = false;
  legacyMigrations = [];
  vi.restoreAllMocks();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { sql: string; params?: unknown[] };
      queries.push(body);

      if (body.sql?.startsWith('INSERT INTO _void_migrations')) {
        appliedMigrations.push(body.params![0] as string);
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
    expect(queries[4].sql).toContain('INSERT INTO _void_migrations');
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
    expect(queries[4].sql).toContain('INSERT INTO _void_migrations');
    expect(queries[5].sql).toBe('CREATE TABLE b;');
    expect(queries[6].sql).toContain('INSERT INTO _void_migrations');
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

    // Should query sqlite_master but NOT issue INSERT OR IGNORE / DROP
    const sqlList = queries.map((q) => q.sql);
    expect(sqlList).toContainEqual(expect.stringContaining('SELECT name FROM sqlite_master'));
    expect(sqlList).not.toContainEqual(
      expect.stringContaining('INSERT OR IGNORE INTO _void_migrations'),
    );
    expect(sqlList).not.toContainEqual(expect.stringContaining('DROP TABLE _migrations'));
  });
});
