/** Create a storage client for a specific R2Bucket instance. */
export function createStorage(bucket: R2Bucket): R2Bucket {
  return bucket;
}

import { requireRuntimeBinding } from "./env";

/** Default storage client — resolves `STORAGE` from the active runtime environment. */
export const storage: R2Bucket = new Proxy({} as R2Bucket, {
  get(_target, prop, receiver) {
    return Reflect.get(requireRuntimeBinding<R2Bucket>("STORAGE"), prop, receiver);
  },
});
