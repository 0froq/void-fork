import type { InferSelectModel } from "drizzle-orm";
import type { users, projects, deployments, resources, domains } from "./schema";

export type User = InferSelectModel<typeof users>;
export type Project = InferSelectModel<typeof projects>;
export type Deployment = InferSelectModel<typeof deployments>;
export type Resource = InferSelectModel<typeof resources>;
export type Domain = InferSelectModel<typeof domains>;

export interface MigrationMeta {
  name: string;
  destructive: boolean;
}

export interface ScheduleMeta {
  name: string;
  cron: string;
}

export interface QueueMeta {
  name: string;
  bindingName: string;
  maxBatchSize?: number;
  maxBatchTimeout?: number;
  maxRetries?: number;
  retryDelay?: number;
}

export const SUPPORTED_MANIFEST_VERSIONS = [2];

export interface AssetConfig {
  not_found_handling?: "none" | "single-page-application" | "404-page";
  html_handling?: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none";
}

export interface DeployManifest {
  version: number;
  bindings: {
    d1?: string[];
    kv?: string[];
    r2?: string[];
    ai?: boolean;
  };
  migrations?: MigrationMeta[];
  schedules?: ScheduleMeta[];
  queues?: QueueMeta[];
  ssr?: boolean;
  framework?: string;
  type?: "void" | "spa" | "static" | "framework";
  revalidate?: number | Record<string, number>;
  prerender?: string[];
  assetConfig?: AssetConfig;
  vars?: Record<string, string>;
  workerMain?: string;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  hashedAssetsPrefix?: string;
  headerRules?: { pattern: string; headers: [string, string][] }[];
  redirectRules?: { source: string; destination: string; status: number }[];
}

export type DeployEvent =
  | { event: "start"; deploymentId: string }
  | { event: "asset_upload"; total: number; new: number; cached: number }
  | { event: "asset_upload_done" }
  | { event: "provisioning"; bindings: string[] }
  | { event: "provisioning_done" }
  | { event: "migration"; name: string; index: number; total: number }
  | { event: "worker_upload"; modules: number }
  | { event: "worker_upload_done" }
  | { event: "queue_setup"; queues: string[] }
  | { event: "prerender"; pages: number }
  | { event: "prerender_done" }
  | {
      event: "done";
      deployment: string;
      url: string;
      urls: string[];
      assets: number;
      workers: number;
      migrations?: number;
    }
  | { event: "error"; message: string; step: string };
