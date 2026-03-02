export interface Env {
  DISPATCH: DispatchNamespace;
  ISR_CACHE: KVNamespace;
  ROUTING: KVNamespace;
  ANALYTICS: AnalyticsEngineDataset;
  USAGE_QUEUE: Queue<unknown>;
  BASE_HOSTNAME?: string;
}
