-- vite-cloud-pragma: allow-destructive
CREATE TABLE users_new (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  login TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, provider_id)
);

INSERT INTO users_new (id, provider, provider_id, login, email, created_at)
  SELECT id, 'github', CAST(github_id AS TEXT), github_login, email, created_at FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
