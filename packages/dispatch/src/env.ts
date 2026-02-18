export interface Env {
  DISPATCH: DispatchNamespace;
  ASSETS: R2Bucket;
  ROUTING: KVNamespace;
  ANALYTICS: AnalyticsEngineDataset;
  BASE_HOSTNAME?: string;
}
