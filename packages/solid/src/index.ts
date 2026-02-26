import solid from "vite-plugin-solid";
import type { Plugin } from "vite";
import { pagesPlugin } from "./plugin-pages";
import { islandsPlugin } from "./plugin-islands";
import { join } from "node:path";

interface PrefetchConfig {
  hoverDelay?: number;
  cacheFor?: number | string | [string, string];
}

export interface VoidSolidOptions {
  solid?: Parameters<typeof solid>[0];
  viewTransitions?: boolean;
  prefetch?: PrefetchConfig;
}

export function voidSolid(options?: VoidSolidOptions): Plugin[] {
  const pagesDir = join(process.cwd(), "pages");
  return [
    solid({ ssr: true, ...options?.solid }),
    pagesPlugin(pagesDir, {
      viewTransitions: options?.viewTransitions,
      prefetch: options?.prefetch,
    }),
    ...islandsPlugin(pagesDir),
  ];
}
