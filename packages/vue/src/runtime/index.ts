import type { CloudContextVariables as _ } from "vite-cloud";

export { Link } from "./link";
export { useRouter } from "./use-router";
export { useShared } from "./use-shared";
export { useForm } from "./use-form";

declare module "vite-cloud" {
  interface CloudContextVariables {
    shared: Record<string, unknown>;
  }
}
