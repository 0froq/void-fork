import vue from '@vitejs/plugin-vue';
import type { Plugin } from 'vite';
import { resolvePagesDir } from 'void/pages';
import { islandsPlugin } from './plugin-islands.ts';
import { pagesPlugin } from './plugin-pages.ts';

export type VoidVueOptions = Readonly<{
  vue?: Parameters<typeof vue>[0];
  viewTransitions?: boolean;
}>;

export function voidVue(options?: VoidVueOptions): Array<Plugin> {
  const root = process.cwd();
  const pagesDir = resolvePagesDir(root);
  return [
    vue(options?.vue) as Plugin,
    ...pagesPlugin(pagesDir, { root, viewTransitions: options?.viewTransitions }),
    ...islandsPlugin(pagesDir, { root }),
  ];
}
