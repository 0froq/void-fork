import { useContext } from "solid-js";
import { SharedContext } from "./context";
import type { CloudContextVariables } from "vite-cloud";

export function useShared<T = CloudContextVariables["shared"]>(): T {
  const shared = useContext(SharedContext);
  if (shared === null) {
    throw new Error("useShared() must be used inside a pages component");
  }
  return shared as T;
}
