-- Shared seed data for local dev and staging
-- Local:   npx wrangler d1 execute vite-cloud-platform --local --file scripts/seed.sql
-- Staging: npx wrangler d1 execute vite-cloud-platform-staging --env staging --file scripts/seed.sql

-- Users
INSERT INTO users (id, provider, provider_id, login, email, github_id, github_login, plan, billing_cycle_start, suspended_reason, role, created_at) VALUES ('user_seed1', 'github', '100001', 'alice', 'alice@example.com', 100001, 'alice', 'free', datetime('now', '-30 days'), NULL, 'user', datetime('now', '-90 days'));
INSERT INTO users (id, provider, provider_id, login, email, github_id, github_login, plan, billing_cycle_start, suspended_reason, role, created_at) VALUES ('user_seed2', 'github', '100002', 'bob', 'bob@example.com', 100002, 'bob', 'solo', datetime('now', '-7 days'), NULL, 'user', datetime('now', '-60 days'));
INSERT INTO users (id, provider, provider_id, login, email, github_id, github_login, plan, billing_cycle_start, suspended_reason, role, created_at) VALUES ('user_seed3', 'google', '100003', 'carol', 'carol@example.com', 100003, 'carol', 'pro', datetime('now', '-60 days'), NULL, 'user', datetime('now', '-60 days'));
INSERT INTO users (id, provider, provider_id, login, email, github_id, github_login, plan, billing_cycle_start, suspended_reason, role, created_at) VALUES ('user_seed4', 'github', '100004', 'dave', 'dave@example.com', 100004, 'dave', 'sponsored', datetime('now', '-90 days'), NULL, 'user', datetime('now', '-90 days'));
INSERT INTO users (id, provider, provider_id, login, email, github_id, github_login, plan, billing_cycle_start, suspended_reason, role, created_at) VALUES ('user_seed5', 'google', '100005', 'eve', 'eve@example.com', 100005, 'eve', 'free', datetime('now', '-30 days'), 'usage_limit_exceeded', 'user', datetime('now', '-30 days'));

-- Projects
INSERT INTO projects (id, user_id, slug, mode, created_at) VALUES ('proj_seed1', 'user_seed1', 'my-app', 'fullstack', datetime('now', '-60 days'));
INSERT INTO projects (id, user_id, slug, mode, created_at) VALUES ('proj_seed2', 'user_seed1', 'docs-site', 'ssg', datetime('now', '-60 days'));
INSERT INTO projects (id, user_id, slug, mode, created_at) VALUES ('proj_seed3', 'user_seed2', 'api-service', 'fullstack', datetime('now', '-60 days'));
INSERT INTO projects (id, user_id, slug, mode, created_at) VALUES ('proj_seed4', 'user_seed2', 'landing-page', 'spa', datetime('now', '-60 days'));
INSERT INTO projects (id, user_id, slug, mode, created_at) VALUES ('proj_seed5', 'user_seed3', 'dashboard', 'framework', datetime('now', '-60 days'));
INSERT INTO projects (id, user_id, slug, mode, created_at) VALUES ('proj_seed6', 'user_seed4', 'blog', 'ssg', datetime('now', '-60 days'));

-- Deployments (live)
INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('dpl_seed1', 'proj_seed1', 'live', '{"bindings":{"d1":["DB"],"kv":["CACHE"]},"migrations":[{"name":"001_create_users.sql","destructive":false}]}', NULL, datetime('now', '-30 days'), datetime('now', '-30 days'));
INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('dpl_seed2', 'proj_seed1', 'live', NULL, NULL, datetime('now', '-7 days'), datetime('now', '-7 days'));
INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('dpl_seed3', 'proj_seed2', 'live', NULL, NULL, datetime('now', '-60 days'), datetime('now', '-60 days'));
INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('dpl_seed4', 'proj_seed3', 'live', '{"bindings":{"d1":["DB"],"r2":["UPLOADS"]},"migrations":[{"name":"001_create_orders.sql","destructive":false},{"name":"002_add_status.sql","destructive":false}]}', NULL, datetime('now', '-30 days'), datetime('now', '-30 days'));
INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('dpl_seed5', 'proj_seed3', 'live', NULL, NULL, datetime('now', '-7 days'), datetime('now', '-7 days'));
INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('dpl_seed6', 'proj_seed4', 'live', NULL, NULL, datetime('now', '-60 days'), datetime('now', '-60 days'));
INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('dpl_seed7', 'proj_seed5', 'live', '{"bindings":{"d1":["DB"],"kv":["SESSIONS"],"r2":["ASSETS"]},"schedules":["0 */6 * * *"]}', NULL, datetime('now', '-30 days'), datetime('now', '-30 days'));
INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('dpl_seed8', 'proj_seed6', 'live', '{"bindings":{"kv":["CACHE"]}}', NULL, datetime('now', '-7 days'), datetime('now', '-7 days'));

-- Deployments (failed)
INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('dpl_fail1', 'proj_seed1', 'failed', NULL, 'destructive migration rejected: 003_drop_users.sql', datetime('now', '-7 days'), NULL);
INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('dpl_fail2', 'proj_seed3', 'failed', NULL, 'migration failed: SQLITE_ERROR: no such table: orders', datetime('now', '-30 days'), NULL);
INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('dpl_fail3', 'proj_seed5', 'failed', NULL, 'worker upload failed: 500 Internal Server Error', datetime('now', '-60 days'), NULL);

-- Today's deployments (deploy count demo)
INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('dpl_today1', 'proj_seed1', 'live', NULL, NULL, datetime('now'), datetime('now'));
INSERT INTO deployments (id, project_id, status, manifest, error_message, created_at, deployed_at) VALUES ('dpl_today2', 'proj_seed1', 'live', NULL, NULL, datetime('now'), datetime('now'));

-- Custom domains
INSERT INTO domains (id, project_id, hostname, cf_hostname_id, status, created_at) VALUES ('dom_seed1', 'proj_seed1', 'myapp.example.com', 'cfhost_fake_001', 'active', datetime('now', '-14 days'));
INSERT INTO domains (id, project_id, hostname, cf_hostname_id, status, created_at) VALUES ('dom_seed2', 'proj_seed3', 'api.bobs-service.com', 'cfhost_fake_002', 'active', datetime('now', '-30 days'));
INSERT INTO domains (id, project_id, hostname, cf_hostname_id, status, created_at) VALUES ('dom_seed3', 'proj_seed5', 'app.carol.dev', 'cfhost_fake_003', 'pending', datetime('now', '-3 days'));

-- Resources
INSERT INTO resources (id, project_id, type, cf_id, binding_name, created_at) VALUES ('res_seed1', 'proj_seed1', 'd1', 'a1b2c3d4-0001-4000-8000-000000000001', 'DB', datetime('now', '-60 days'));
INSERT INTO resources (id, project_id, type, cf_id, binding_name, created_at) VALUES ('res_seed2', 'proj_seed1', 'kv', 'a1b2c3d4-0002-4000-8000-000000000002', 'CACHE', datetime('now', '-60 days'));
INSERT INTO resources (id, project_id, type, cf_id, binding_name, created_at) VALUES ('res_seed3', 'proj_seed3', 'd1', 'a1b2c3d4-0003-4000-8000-000000000003', 'DB', datetime('now', '-60 days'));
INSERT INTO resources (id, project_id, type, cf_id, binding_name, created_at) VALUES ('res_seed4', 'proj_seed3', 'r2', 'a1b2c3d4-0004-4000-8000-000000000004', 'UPLOADS', datetime('now', '-60 days'));
INSERT INTO resources (id, project_id, type, cf_id, binding_name, created_at) VALUES ('res_seed5', 'proj_seed5', 'd1', 'a1b2c3d4-0005-4000-8000-000000000005', 'DB', datetime('now', '-60 days'));
INSERT INTO resources (id, project_id, type, cf_id, binding_name, created_at) VALUES ('res_seed6', 'proj_seed5', 'kv', 'a1b2c3d4-0006-4000-8000-000000000006', 'SESSIONS', datetime('now', '-60 days'));
INSERT INTO resources (id, project_id, type, cf_id, binding_name, created_at) VALUES ('res_seed7', 'proj_seed5', 'r2', 'a1b2c3d4-0007-4000-8000-000000000007', 'ASSETS', datetime('now', '-60 days'));
