import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { resolvePagesDir } from 'void/pages';
import { islandsPlugin } from './plugin-islands.ts';
import { pagesPlugin } from './plugin-pages.ts';

type PrefetchConfig = {
  hoverDelay?: number;
  cacheFor?: number | string | [string, string];
};

export type VoidReactOptions = Readonly<{
  react?: Parameters<typeof react>[0];
  viewTransitions?: boolean;
  prefetch?: PrefetchConfig;
}>;

export function voidReact(options?: VoidReactOptions): Array<Plugin> {
  const root = process.cwd();
  const pagesDir = resolvePagesDir(root);
  return [
    ...react(options?.react),
    pagesPlugin(pagesDir, {
      root,
      viewTransitions: options?.viewTransitions,
      prefetch: options?.prefetch,
    }),
    ...islandsPlugin(pagesDir, { root }),
  ];
}
