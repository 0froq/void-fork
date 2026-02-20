import { inject } from "vue";

export function useShared<T = Record<string, unknown>>(): T {
  const shared = inject<T>("__vc_shared");
  if (!shared) throw new Error("useShared() must be used inside a Vite Cloud page");
  return shared;
}
