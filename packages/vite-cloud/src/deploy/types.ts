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
