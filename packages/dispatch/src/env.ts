export interface Env {
  DISPATCH: DispatchNamespace;
  ASSETS: R2Bucket;
  ROUTING: KVNamespace;
  ANALYTICS: AnalyticsEngineDataset;
  USAGE_QUEUE: Queue<unknown>;
  BASE_HOSTNAME?: string;
}
