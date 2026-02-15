ALTER TABLE users ADD COLUMN provider TEXT NOT NULL DEFAULT 'github';
ALTER TABLE users ADD COLUMN provider_id TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN login TEXT NOT NULL DEFAULT '';
UPDATE users SET provider_id = CAST(github_id AS TEXT), login = github_login;
CREATE UNIQUE INDEX idx_users_provider_id ON users(provider, provider_id);
