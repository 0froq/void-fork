import { svelte } from '@sveltejs/vite-plugin-svelte';
import { join } from 'pathe';
import type { Plugin } from 'vite';
import { islandsPlugin } from './plugin-islands.ts';
import { pagesPlugin } from './plugin-pages.ts';

type PrefetchConfig = {
  hoverDelay?: number;
  cacheFor?: number | string | [string, string];
};

export type VoidSvelteOptions = Readonly<{
  svelte?: Parameters<typeof svelte>[0];
  viewTransitions?: boolean;
  prefetch?: PrefetchConfig;
}>;

export function voidSvelte(options?: VoidSvelteOptions): ReadonlyArray<Plugin> {
  const pagesDir = join(process.cwd(), 'pages');
  return [
    ...(svelte(options?.svelte) as ReadonlyArray<Plugin>),
    pagesPlugin(pagesDir, {
      viewTransitions: options?.viewTransitions,
      prefetch: options?.prefetch,
    }),
    ...islandsPlugin(pagesDir),
  ];
}
