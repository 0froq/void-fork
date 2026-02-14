export interface User {
  id: string;
  github_id: number;
  github_login: string;
  email: string | null;
  created_at: string;
}

export interface Project {
  id: string;
  user_id: string;
  slug: string;
  name: string;
  created_at: string;
}

export interface Deployment {
  id: string;
  project_id: string;
  status: "pending" | "uploading" | "migrating" | "live" | "failed";
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

export interface DeployManifest {
  bindings: {
    d1?: string[];
    kv?: string[];
    r2?: string[];
  };
  migrations?: MigrationMeta[];
}
