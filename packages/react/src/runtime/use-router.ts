import { useContext } from "react";
import { RouterContext } from "./context";
import { ssrProxy } from "void/pages-client";
import type { VoidRouter } from "void/pages-client";

export type { VoidRouter } from "void/pages-client";

export function useRouter(): VoidRouter {
  return useContext(RouterContext) ?? ssrProxy;
}
