export type Env = {
  DISPATCH: DispatchNamespace;
  ISR_CACHE: KVNamespace;
  ROUTING: KVNamespace;
  STATIC_ASSETS: KVNamespace;
  STATIC_ASSETS_R2: R2Bucket;
  ANALYTICS: AnalyticsEngineDataset;
  USAGE_QUEUE: Queue<unknown>;
  BASE_HOSTNAME?: string;
};
