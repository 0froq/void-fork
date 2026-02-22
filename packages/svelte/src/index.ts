import { svelte } from "@sveltejs/vite-plugin-svelte";
import type { Plugin } from "vite";
import { pagesPlugin } from "./plugin-pages";
import { join } from "node:path";

export interface ViteCloudSvelteOptions {
  svelte?: Parameters<typeof svelte>[0];
  viewTransitions?: boolean;
}

export function viteCloudSvelte(options?: ViteCloudSvelteOptions): Plugin[] {
  const pagesDir = join(process.cwd(), "pages");
  return [
    ...(svelte(options?.svelte) as Plugin[]),
    pagesPlugin(pagesDir, { viewTransitions: options?.viewTransitions }),
  ];
}
