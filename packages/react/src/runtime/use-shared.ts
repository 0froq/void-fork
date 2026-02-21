import { useContext } from "react";
import type { CloudContextVariables } from "vite-cloud";
import { SharedContext } from "./context";

export function useShared<T = CloudContextVariables["shared"]>(): T {
  const shared = useContext(SharedContext);
  if (!shared) throw new Error("useShared() must be used inside a Vite Cloud page");
  return shared as T;
}
