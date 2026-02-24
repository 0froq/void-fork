import vue from "@vitejs/plugin-vue";
import type { Plugin } from "vite";
import { scriptServerPlugin } from "./plugin-script-server";
import { pagesPlugin } from "./plugin-pages";
import { islandsPlugin } from "./plugin-islands";
import { join } from "node:path";

export interface VoidVueOptions {
  vue?: Parameters<typeof vue>[0];
  viewTransitions?: boolean;
}

export function voidVue(options?: VoidVueOptions): Plugin[] {
  const pagesDir = join(process.cwd(), "pages");
  return [
    scriptServerPlugin(pagesDir),
    vue(options?.vue) as Plugin,
    pagesPlugin(pagesDir, { viewTransitions: options?.viewTransitions }),
    islandsPlugin(pagesDir),
  ];
}
