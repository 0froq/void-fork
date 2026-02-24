/** Create a storage client for a specific R2Bucket instance. */
export function createStorage(bucket: R2Bucket): R2Bucket {
  return bucket;
}

import { env } from "cloudflare:workers";

/** Default storage client — uses `env.STORAGE` from `cloudflare:workers`. */
export const storage: R2Bucket = new Proxy({} as R2Bucket, {
  get(_target, prop, receiver) {
    return Reflect.get(env.STORAGE, prop, receiver);
  },
});
