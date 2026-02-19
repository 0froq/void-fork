/** Stub interface augmented by generated .vite-cloud/queues.d.ts */
export interface QueueMap {}

import { env } from "cloudflare:workers";

/** Typed queue producers — uses `env.QUEUE_*` from `cloudflare:workers`. */
export const queues: QueueMap = new Proxy({} as QueueMap, {
  get(_, name: string) {
    const bindingName = "QUEUE_" + name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    return (env as any)[bindingName];
  },
});
