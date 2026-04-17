import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { PlatformWorkerName, PlatformEnv } from './admin/platform-workers';
import type { PlanId } from './tiers';
import type { InvitationStatus } from './types';

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull().default('github'),
    provider_id: text('provider_id').notNull().default(''),
    login: text('login').notNull().default(''),
    email: text('email'),
    plan: text('plan').notNull().default('free').$type<PlanId>(),
    role: text('role').notNull().default('user').$type<'user' | 'admin'>(),
    billing_cycle_start: timestamp('billing_cycle_start', { mode: 'string' })
      .notNull()
      .defaultNow(),
    suspended_reason: text('suspended_reason'),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('idx_users_provider_id').on(t.provider, t.provider_id),
    index('idx_users_email').on(t.email),
  ],
);

// ---------------------------------------------------------------------------
// oauth_accounts
// ---------------------------------------------------------------------------
export const oauthAccounts = pgTable(
  'oauth_accounts',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    provider_id: text('provider_id').notNull(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('idx_oauth_accounts_provider_id').on(t.provider, t.provider_id),
    index('idx_oauth_accounts_user_id').on(t.user_id),
  ],
);

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------
export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id),
    slug: text('slug').notNull(),
    type: text('mode').notNull().default('worker').$type<'void' | 'spa' | 'static' | 'framework'>(),
    active_deployment_id: text('active_deployment_id'),
    websocket_version: integer('websocket_version').notNull().default(0),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.user_id, t.slug),
    uniqueIndex('idx_projects_slug').on(t.slug),
    index('idx_projects_user_id').on(t.user_id),
  ],
);

// ---------------------------------------------------------------------------
// deployments
// ---------------------------------------------------------------------------
export const deployments = pgTable(
  'deployments',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id),
    status: text('status')
      .notNull()
      .default('pending')
      .$type<
        | 'pending'
        | 'uploading'
        | 'migrating'
        | 'prerendering'
        | 'canceling'
        | 'live'
        | 'failed'
        | 'canceled'
      >(),
    manifest: text('manifest'),
    source: text('source'),
    commit: text('commit'),
    error_message: text('error_message'),
    asset_hashes: text('asset_hashes'),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
    deployed_at: timestamp('deployed_at', { mode: 'string' }),
    retained: boolean('retained').notNull().default(false),
    applied_migrations: text('applied_migrations'),
  },
  (t) => [
    index('idx_deployments_project_id').on(t.project_id, t.created_at),
    index('idx_deployments_project_status').on(t.project_id, t.status),
  ],
);

// ---------------------------------------------------------------------------
// project_secrets
// ---------------------------------------------------------------------------
export const projectSecrets = pgTable(
  'project_secrets',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    key_version: text('key_version').notNull(),
    managed_reason: text('managed_reason'),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.project_id, t.name),
    index('idx_project_secrets_project_id').on(t.project_id),
  ],
);

// ---------------------------------------------------------------------------
// resources
// ---------------------------------------------------------------------------
export const resources = pgTable(
  'resources',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id),
    type: text('type').notNull().$type<'d1' | 'kv' | 'r2' | 'queue' | 'hyperdrive'>(),
    cf_id: text('cf_id').notNull(),
    binding_name: text('binding_name').notNull(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.project_id, t.type, t.binding_name)],
);

// ---------------------------------------------------------------------------
// domains
// ---------------------------------------------------------------------------
export const domains = pgTable(
  'domains',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id),
    hostname: text('hostname').notNull().unique(),
    cf_hostname_id: text('cf_hostname_id').notNull(),
    status: text('status').notNull().default('pending').$type<'pending' | 'active'>(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [index('idx_domains_project_id').on(t.project_id, t.created_at)],
);

// ---------------------------------------------------------------------------
// platform_events (audit log for admin platform rollbacks)
// ---------------------------------------------------------------------------
export const platformEvents = pgTable(
  'platform_events',
  {
    id: text('id').primaryKey(),
    batch_id: text('batch_id'),
    action: text('action').notNull().$type<'rollback' | 'rollback_all'>(),
    worker_name: text('worker_name').notNull().$type<PlatformWorkerName>(),
    environment: text('environment').notNull().$type<PlatformEnv>(),
    version_id: text('version_id').notNull(),
    script_name: text('script_name').notNull(),
    status: text('status')
      .notNull()
      .default('pending')
      .$type<'pending' | 'success' | 'failed' | 'skipped'>(),
    error_message: text('error_message'),
    admin_user_id: text('admin_user_id').notNull(),
    admin_login: text('admin_login').notNull(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_platform_events_batch_id').on(t.batch_id),
    index('idx_platform_events_env_created').on(t.environment, t.created_at),
  ],
);

// ---------------------------------------------------------------------------
// oauth_nonces — short-lived, single-use tokens for OAuth CSRF/replay protection.
// Stored in PostgreSQL (not KV) because the login and callback requests can hit
// different CF colos, and KV's eventual consistency would make nonce lookups flaky.
// Atomic DELETE … RETURNING guarantees true single-use semantics.
// ---------------------------------------------------------------------------
export const oauthNonces = pgTable('oauth_nonces', {
  nonce: text('nonce').primaryKey(),
  expires_at: timestamp('expires_at', { mode: 'string' }).notNull(),
});

// ---------------------------------------------------------------------------
// auth_codes — short-lived, single-use authorization codes for dashboard login.
// Same rationale as oauth_nonces: cross-colo consistency requires PostgreSQL,
// and atomic DELETE … RETURNING guarantees single-use.
// ---------------------------------------------------------------------------
export const authCodes = pgTable('auth_codes', {
  code: text('code').primaryKey(),
  jwt: text('jwt').notNull(),
  expires_at: timestamp('expires_at', { mode: 'string' }).notNull(),
});

// ---------------------------------------------------------------------------
// migration_renames — audit log of successfully committed `/migrations/rename`
// pairs. Written inside the same locked transaction as the D1 UPDATE +
// `renameAppliedMigrationsForProject` healing write, so a row exists iff
// both the D1 UPDATE and the pg rewrite have committed.
//
// This table is a durable, rename-specific second corroboration source for
// same-payload retries after a partial-failure heal: a matching row means
// "this exact (project_id, from, to) rename was already committed here, so
// an idempotent retry that observes `to` in D1 and not `from` is genuine
// rather than a fat-fingered request against an unrelated existing migration".
// It is needed because the heal rewrites the active deployment's
// `applied_migrations` to the new name, erasing the active-deployment-based
// corroboration that would otherwise classify the retry.
// ---------------------------------------------------------------------------
export const migrationRenames = pgTable(
  'migration_renames',
  {
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    from_name: text('from_name').notNull(),
    to_name: text('to_name').notNull(),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.project_id, t.from_name, t.to_name] }),
    index('idx_migration_renames_project_id').on(t.project_id),
  ],
);

// ---------------------------------------------------------------------------
// invitations
// ---------------------------------------------------------------------------
export const invitations = pgTable(
  'invitations',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    status: text('status').notNull().default('pending').$type<InvitationStatus>(),
    invited_by: text('invited_by')
      .notNull()
      .references(() => users.id),
    accepted_by: text('accepted_by').references(() => users.id),
    revoked_at: timestamp('revoked_at', { mode: 'string' }),
    revoked_by: text('revoked_by').references(() => users.id),
    created_at: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),
    accepted_at: timestamp('accepted_at', { mode: 'string' }),
  },
  (t) => [index('idx_invitations_email').on(t.email), index('idx_invitations_status').on(t.status)],
);
