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
}

export interface HeaderRule {
  pattern: string;
  headers: [string, string][];
}

export const SUPPORTED_MANIFEST_VERSIONS = [1];

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
  framework?: boolean;
  revalidate?: number | Record<string, number>;
  prerender?: string[];
  static?: "spa" | "ssg";
  assetsDir?: string;
  assetHashes?: Record<string, string>;
  headers?: HeaderRule[];
  vars?: Record<string, string>;
  workerMain?: string;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
}
