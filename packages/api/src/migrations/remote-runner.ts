const CF_API_BASE = "https://api.cloudflare.com/client/v4/accounts";

export interface RemoteMigration {
  name: string;
  sql: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Run migrations against a remote D1 database via the CF REST API.
 *
 * 1. Ensure _migrations tracking table exists
 * 2. Query already-applied migrations
 * 3. For each pending: execute SQL + record in _migrations
 */
export async function runRemoteMigrations(
  accountId: string,
  apiToken: string,
  databaseId: string,
  migrations: RemoteMigration[],
): Promise<MigrationResult> {
  // Ensure tracking table exists
  await queryD1(accountId, apiToken, databaseId, {
    sql: `CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,
  });

  // Get already-applied migrations
  const appliedResult = await queryD1(accountId, apiToken, databaseId, {
    sql: "SELECT name FROM _migrations",
  });
  const applied = new Set(appliedResult.results.map((row) => row.name as string));

  const result: MigrationResult = { applied: [], skipped: [] };

  for (const migration of migrations) {
    if (applied.has(migration.name)) {
      result.skipped.push(migration.name);
      continue;
    }

    // Execute migration SQL + record in _migrations atomically (single D1 transaction)
    await batchQueryD1(accountId, apiToken, databaseId, [
      { sql: migration.sql },
      {
        sql: "INSERT INTO _migrations (name, applied_at) VALUES (?, ?)",
        params: [migration.name, new Date().toISOString()],
      },
    ]);

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

async function batchQueryD1(
  accountId: string,
  apiToken: string,
  databaseId: string,
  queries: D1Query[],
): Promise<D1QueryResponse[]> {
  const url = `${CF_API_BASE}/${accountId}/d1/database/${databaseId}/query`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(queries),
  });

  const json = (await response.json()) as {
    success: boolean;
    errors: { code: number; message: string }[];
    result: D1QueryResponse[];
  };

  if (!json.success) {
    const msg = json.errors.map((e) => e.message).join(", ");
    throw new Error(`D1 migration failed: ${msg}`);
  }

  return json.result;
}

export async function queryD1(
  accountId: string,
  apiToken: string,
  databaseId: string,
  query: D1Query,
): Promise<D1QueryResponse> {
  const url = `${CF_API_BASE}/${accountId}/d1/database/${databaseId}/query`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(query),
  });

  const json = (await response.json()) as {
    success: boolean;
    errors: { code: number; message: string }[];
    result: D1QueryResponse[];
  };

  if (!json.success) {
    const msg = json.errors.map((e) => e.message).join(", ");
    throw new Error(`D1 migration failed: ${msg}`);
  }

  // D1 query API returns an array of results (one per statement)
  return json.result[0] ?? { results: [] };
}
