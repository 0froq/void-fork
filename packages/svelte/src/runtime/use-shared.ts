import type { CloudContextVariables } from "vite-cloud";
import { getContext } from "svelte";

export function useShared<T = CloudContextVariables["shared"]>(): T {
  const ctx = getContext<{ value: T }>("__vc_shared");
  if (!ctx) throw new Error("useShared() must be used inside a Vite Cloud page");
  return ctx.value;
}
