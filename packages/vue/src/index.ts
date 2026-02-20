import vue from "@vitejs/plugin-vue";
import type { Plugin } from "vite";
import { scriptServerPlugin } from "./plugin-script-server";
import { pagesPlugin } from "./plugin-pages";
import { join } from "node:path";

export interface ViteCloudVueOptions {
  vue?: Parameters<typeof vue>[0];
}

export function viteCloudVue(options?: ViteCloudVueOptions): Plugin[] {
  const pagesDir = join(process.cwd(), "pages");
  return [scriptServerPlugin(pagesDir), vue(options?.vue) as Plugin, pagesPlugin(pagesDir)];
}
