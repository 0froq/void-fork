import solid from "vite-plugin-solid";
import type { Plugin } from "vite";
import { pagesPlugin } from "./plugin-pages";
import { join } from "node:path";

export interface ViteCloudSolidOptions {
  solid?: Parameters<typeof solid>[0];
  viewTransitions?: boolean;
}

export function viteCloudSolid(options?: ViteCloudSolidOptions): Plugin[] {
  const pagesDir = join(process.cwd(), "pages");
  return [
    solid({ ssr: true, ...options?.solid }),
    pagesPlugin(pagesDir, { viewTransitions: options?.viewTransitions }),
  ];
}
