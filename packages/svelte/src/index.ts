import { svelte } from "@sveltejs/vite-plugin-svelte";
import type { Plugin } from "vite";
import { pagesPlugin } from "./plugin-pages";
import { join } from "node:path";

export interface VoidSvelteOptions {
  svelte?: Parameters<typeof svelte>[0];
  viewTransitions?: boolean;
}

export function voidSvelte(options?: VoidSvelteOptions): Plugin[] {
  const pagesDir = join(process.cwd(), "pages");
  return [
    ...(svelte(options?.svelte) as Plugin[]),
    pagesPlugin(pagesDir, { viewTransitions: options?.viewTransitions }),
  ];
}
