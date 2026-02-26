import { svelte } from "@sveltejs/vite-plugin-svelte";
import type { Plugin } from "vite";
import { pagesPlugin } from "./plugin-pages";
import { islandsPlugin } from "./plugin-islands";
import { join } from "node:path";

interface PrefetchConfig {
  hoverDelay?: number;
  cacheFor?: number | string | [string, string];
}

export interface VoidSvelteOptions {
  svelte?: Parameters<typeof svelte>[0];
  viewTransitions?: boolean;
  prefetch?: PrefetchConfig;
}

export function voidSvelte(options?: VoidSvelteOptions): Plugin[] {
  const pagesDir = join(process.cwd(), "pages");
  return [
    ...(svelte(options?.svelte) as Plugin[]),
    pagesPlugin(pagesDir, {
      viewTransitions: options?.viewTransitions,
      prefetch: options?.prefetch,
    }),
    ...islandsPlugin(pagesDir),
  ];
}
