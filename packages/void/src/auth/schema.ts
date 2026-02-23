/** Name of the D1 table that stores user accounts. */
export const AUTH_USERS_TABLE = "auth_users";

/** SQL DDL statement that creates the auth tables (idempotent via `IF NOT EXISTS`). */
export const CREATE_AUTH_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS auth_users (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    email TEXT,
    name TEXT,
    avatar_url TEXT,
    password_hash TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(provider, provider_id)
  )
`;

/** Generate a random user ID (UUID v4). */
export function generateUserId(): string {
  return crypto.randomUUID();
}
