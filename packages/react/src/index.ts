import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { pagesPlugin } from "./plugin-pages";
import { join } from "node:path";

export interface ViteCloudReactOptions {
  react?: Parameters<typeof react>[0];
  viewTransitions?: boolean;
}

export function viteCloudReact(options?: ViteCloudReactOptions): Plugin[] {
  const pagesDir = join(process.cwd(), "pages");
  return [
    ...react(options?.react),
    pagesPlugin(pagesDir, { viewTransitions: options?.viewTransitions }),
  ];
}
