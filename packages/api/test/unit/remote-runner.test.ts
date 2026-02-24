import { describe, it, expect, vi, beforeEach } from "vitest";
import { runRemoteMigrations } from "../../src/migrations/remote-runner";

const ACCOUNT_ID = "test-account";
const API_TOKEN = "test-token";
const DATABASE_ID = "d1-uuid-123";

// Track all queries made to D1 (may be single objects or batched arrays)
let queries: ({ sql: string; params?: unknown[] } | { sql: string; params?: unknown[] }[])[] = [];

// Applied migrations state (simulates _migrations table)
let appliedMigrations: string[] = [];

beforeEach(() => {
  queries = [];
  appliedMigrations = [];
  vi.restoreAllMocks();

  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      queries.push(body);

      // Handle batched queries (array of statements)
      if (Array.isArray(body)) {
        for (const stmt of body) {
          if (stmt.sql?.startsWith("INSERT INTO _migrations")) {
            appliedMigrations.push(stmt.params[0]);
          }
        }
        return new Response(
          JSON.stringify({
            success: true,
            errors: [],
            result: body.map(() => ({ results: [] })),
          }),
        );
      }

      // Handle single queries (CREATE TABLE, SELECT)
      if (body.sql === "SELECT name FROM _migrations") {
        return new Response(
          JSON.stringify({
            success: true,
            errors: [],
            result: [{ results: appliedMigrations.map((name) => ({ name })) }],
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

describe("runRemoteMigrations", () => {
  it("creates _migrations table and queries applied", async () => {
    await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, []);

    expect(queries[0]).toEqual(
      expect.objectContaining({
        sql: expect.stringContaining("CREATE TABLE IF NOT EXISTS _migrations"),
      }),
    );
    expect(queries[1]).toEqual(expect.objectContaining({ sql: "SELECT name FROM _migrations" }));
  });

  it("applies pending migrations in a batched request", async () => {
    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: "001_create.sql", sql: "CREATE TABLE users (id TEXT);" },
    ]);

    expect(result.applied).toEqual(["001_create.sql"]);
    expect(result.skipped).toEqual([]);
    // Should have: CREATE TABLE, SELECT, batched [migration SQL, INSERT]
    expect(queries).toHaveLength(3);
    // Third query should be a batch (array) with migration + INSERT
    const batch = queries[2];
    expect(Array.isArray(batch)).toBe(true);
    const batchArr = batch as { sql: string; params?: unknown[] }[];
    expect(batchArr).toHaveLength(2);
    expect(batchArr[0].sql).toBe("CREATE TABLE users (id TEXT);");
    expect(batchArr[1].sql).toContain("INSERT INTO _migrations");
    expect(batchArr[1].params![0]).toBe("001_create.sql");
  });

  it("skips already-applied migrations", async () => {
    appliedMigrations = ["001_create.sql"];

    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: "001_create.sql", sql: "CREATE TABLE users (id TEXT);" },
      { name: "002_add_col.sql", sql: "ALTER TABLE users ADD COLUMN name TEXT;" },
    ]);

    expect(result.skipped).toEqual(["001_create.sql"]);
    expect(result.applied).toEqual(["002_add_col.sql"]);
  });

  it("applies multiple pending migrations in order", async () => {
    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
      { name: "001_create.sql", sql: "CREATE TABLE a;" },
      { name: "002_more.sql", sql: "CREATE TABLE b;" },
    ]);

    expect(result.applied).toEqual(["001_create.sql", "002_more.sql"]);
    // CREATE TABLE IF NOT EXISTS, SELECT, batch1, batch2
    expect(queries).toHaveLength(4);
    // Each migration is a batch of [SQL, INSERT]
    expect(Array.isArray(queries[2])).toBe(true);
    expect(Array.isArray(queries[3])).toBe(true);
  });

  it("handles empty migrations list", async () => {
    const result = await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, []);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("throws on D1 API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              errors: [{ code: 1000, message: "database not found" }],
              result: [],
            }),
          ),
      ),
    );

    await expect(
      runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, [
        { name: "001.sql", sql: "CREATE TABLE x;" },
      ]),
    ).rejects.toThrow("D1 migration failed");
  });

  it("sends correct URL with account and database ID", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    await runRemoteMigrations(ACCOUNT_ID, API_TOKEN, DATABASE_ID, []);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain(`/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`);
  });
});
