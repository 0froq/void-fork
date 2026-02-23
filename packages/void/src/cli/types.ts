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

export interface DeployManifest {
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
}
