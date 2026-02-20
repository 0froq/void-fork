import { sql } from "drizzle-orm";
import { sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { PlanId } from "./tiers";

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull().default("github"),
    provider_id: text("provider_id").notNull().default(""),
    login: text("login").notNull().default(""),
    email: text("email"),
    plan: text("plan").notNull().default("free").$type<PlanId>(),
    role: text("role").notNull().default("user").$type<"user" | "admin">(),
    billing_cycle_start: text("billing_cycle_start")
      .notNull()
      .default(sql`(datetime('now'))`),
    suspended_reason: text("suspended_reason"),
    created_at: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [uniqueIndex("idx_users_provider_id").on(t.provider, t.provider_id)],
);

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------
export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    slug: text("slug").notNull(),
    mode: text("mode")
      .notNull()
      .default("worker")
      .$type<"fullstack" | "spa" | "ssg" | "framework">(),
    created_at: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [unique().on(t.user_id, t.slug)],
);

// ---------------------------------------------------------------------------
// deployments
// ---------------------------------------------------------------------------
export const deployments = sqliteTable("deployments", {
  id: text("id").primaryKey(),
  project_id: text("project_id")
    .notNull()
    .references(() => projects.id),
  status: text("status")
    .notNull()
    .default("pending")
    .$type<"pending" | "uploading" | "migrating" | "live" | "failed">(),
  manifest: text("manifest"),
  source: text("source"),
  error_message: text("error_message"),
  created_at: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  deployed_at: text("deployed_at"),
});

// ---------------------------------------------------------------------------
// resources
// ---------------------------------------------------------------------------
export const resources = sqliteTable(
  "resources",
  {
    id: text("id").primaryKey(),
    project_id: text("project_id")
      .notNull()
      .references(() => projects.id),
    type: text("type").notNull().$type<"d1" | "kv" | "r2" | "queue">(),
    cf_id: text("cf_id").notNull(),
    binding_name: text("binding_name").notNull(),
    created_at: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [unique().on(t.project_id, t.type, t.binding_name)],
);

// ---------------------------------------------------------------------------
// domains
// ---------------------------------------------------------------------------
export const domains = sqliteTable("domains", {
  id: text("id").primaryKey(),
  project_id: text("project_id")
    .notNull()
    .references(() => projects.id),
  hostname: text("hostname").notNull().unique(),
  cf_hostname_id: text("cf_hostname_id").notNull(),
  status: text("status").notNull().default("pending").$type<"pending" | "active">(),
  created_at: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});
