/**
 * Virtual module — resolved by the @void/md Vite plugin at build time.
 * This stub provides type information for TypeScript and linters.
 */
export {};

export interface VoidMdPage {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  headings: Array<{ depth: number; slug: string; text: string }>;
}

declare const pages: Array<VoidMdPage>;
export default pages;
