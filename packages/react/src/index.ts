import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { pagesPlugin } from "./plugin-pages";
import { islandsPlugin } from "./plugin-islands";
import { join } from "node:path";

export interface VoidReactOptions {
  react?: Parameters<typeof react>[0];
  viewTransitions?: boolean;
}

export function voidReact(options?: VoidReactOptions): Plugin[] {
  const pagesDir = join(process.cwd(), "pages");
  return [
    ...react(options?.react),
    pagesPlugin(pagesDir, { viewTransitions: options?.viewTransitions }),
    islandsPlugin(pagesDir),
  ];
}
