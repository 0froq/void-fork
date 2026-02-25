import MarkdownExit from "markdown-exit";
import matter from "gray-matter";
import Shiki from "@shikijs/markdown-it";
import {
  transformerMetaHighlight,
  transformerNotationDiff,
  transformerNotationHighlight,
  transformerNotationFocus,
  transformerNotationErrorLevel,
} from "@shikijs/transformers";
import anchor from "markdown-it-anchor";
import attrs from "markdown-it-attrs";
import { full as emoji } from "markdown-it-emoji";
import { preWrapperPlugin } from "./plugins/pre-wrapper";
import { containerPlugin } from "./plugins/containers";
import { gitHubAlertsPlugin } from "./plugins/github-alerts";
import { linkPlugin } from "./plugins/link";
import { imagePlugin } from "./plugins/image";
import { lineNumberPlugin } from "./plugins/line-numbers";
import { tocPlugin } from "./plugins/toc";

export interface Heading {
  depth: number;
  slug: string;
  text: string;
}

export interface CompileResult {
  html: string;
  frontmatter: Record<string, unknown>;
  headings: Heading[];
  title: string;
}

export interface CompileOptions {
  shiki?: {
    themes?: { light: string; dark: string };
    langs?: string[];
  };
}

let compilerPromise: Promise<MarkdownExit> | null = null;

async function getCompiler(options?: CompileOptions): Promise<MarkdownExit> {
  if (compilerPromise) return compilerPromise;
  compilerPromise = createCompiler(options);
  return compilerPromise;
}

async function createCompiler(options?: CompileOptions): Promise<MarkdownExit> {
  const md = new MarkdownExit({ html: true, linkify: true });

  // Shiki highlighting with dual themes
  const shikiPlugin = await Shiki({
    themes: options?.shiki?.themes ?? {
      light: "github-light",
      dark: "github-dark",
    },
    transformers: [
      transformerMetaHighlight(),
      transformerNotationDiff(),
      transformerNotationHighlight(),
      transformerNotationFocus(),
      transformerNotationErrorLevel(),
    ],
  });
  // @ts-expect-error @shikijs/markdown-it types reference @types/markdown-it, structurally incompatible with markdown-exit
  md.use(shikiPlugin);

  // Code block wrapping (must come after shiki, before line-numbers)
  md.use(preWrapperPlugin);

  // Container blocks: :::tip, :::warning, etc.
  md.use(containerPlugin);

  // Image path normalization + lazy loading
  md.use(imagePlugin, { lazyLoading: true });

  // Link handling: external attrs, .md normalization
  md.use(linkPlugin);

  // Line numbers (opt-in per code block by default)
  md.use(lineNumberPlugin, false);

  // GitHub alerts: > [!NOTE], > [!TIP], etc.
  md.use(gitHubAlertsPlugin);

  // Attribute syntax: {.class #id}
  md.use(attrs);

  // Emoji shortcodes
  md.use(emoji);

  // Heading anchors
  // @ts-expect-error markdown-it-anchor types reference @types/markdown-it, structurally incompatible with markdown-exit
  md.use(anchor, {
    permalink: anchor.permalink.ariaHidden({ placement: "before" }),
  });

  // [[toc]] directive
  md.use(tocPlugin);

  return md;
}

function extractHeadings(tokens: any[]): Heading[] {
  const headings: Heading[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === "heading_open") {
      const depth = Number(token.tag.slice(1));
      const slug = token.attrGet?.("id") ?? "";
      const inline = tokens[i + 1];
      const text = (
        inline?.children
          ?.filter((t: any) => t.type === "text" || t.type === "code_inline")
          .map((t: any) => t.content)
          .join("") ?? ""
      ).trim();
      headings.push({ depth, slug, text });
    }
  }
  return headings;
}

export async function compile(source: string, options?: CompileOptions): Promise<CompileResult> {
  const { data: frontmatter, content } = matter(source);
  const compiler = await getCompiler(options);

  const env: Record<string, unknown> = {};
  const tokens = compiler.parse(content, env);
  const headings = extractHeadings(tokens);
  const html = await compiler.renderAsync(content, env);

  const title = (frontmatter.title as string) ?? headings.find((h) => h.depth === 1)?.text ?? "";

  return { html, frontmatter, headings, title };
}

/** Reset the compiler (for testing or options change) */
export function resetCompiler(): void {
  compilerPromise = null;
}
