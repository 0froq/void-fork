export const AUTH_USERS_TABLE = "auth_users";

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

export function generateUserId(): string {
  return crypto.randomUUID();
}
