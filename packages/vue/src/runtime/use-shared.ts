import type { CloudContextVariables } from "vite-cloud";
import { inject } from "vue";

export function useShared<T = CloudContextVariables["shared"]>(): T {
  const shared = inject<T>("__vc_shared");
  if (!shared) throw new Error("useShared() must be used inside a Vite Cloud page");
  return shared;
}
