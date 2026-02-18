export interface User {
  id: string;
  provider: string;
  provider_id: string;
  login: string;
  email: string | null;
  plan: string;
  created_at: string;
}

export interface Project {
  id: string;
  user_id: string;
  slug: string;
  name: string;
  mode: string;
  created_at: string;
}

export interface Deployment {
  id: string;
  project_id: string;
  status: "pending" | "uploading" | "migrating" | "live" | "failed";
  source: string | null;
  manifest: string | null;
  created_at: string;
  deployed_at: string | null;
}

export interface Resource {
  id: string;
  project_id: string;
  type: "d1" | "kv" | "r2";
  cf_id: string;
  binding_name: string;
  created_at: string;
}

export interface MigrationMeta {
  name: string;
  destructive: boolean;
}

export interface ScheduleMeta {
  name: string;
  cron: string;
}

export interface HeaderRule {
  pattern: string;
  headers: [string, string][];
}

export interface Domain {
  id: string;
  project_id: string;
  hostname: string;
  cf_hostname_id: string;
  status: string;
  created_at: string;
}

export interface DeployManifest {
  bindings: {
    d1?: string[];
    kv?: string[];
    r2?: string[];
  };
  migrations?: MigrationMeta[];
  schedules?: ScheduleMeta[];
  ssr?: boolean;
  framework?: boolean;
  revalidate?: number;
  static?: "spa" | "ssg";
  assetHashes?: Record<string, string>;
  headers?: HeaderRule[];
}
