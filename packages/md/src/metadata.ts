import matter from 'gray-matter';
import MarkdownExit from 'markdown-exit';
import type { Token } from 'markdown-exit';
import anchor from 'markdown-it-anchor';
import type { Heading } from './compile.ts';

let metadataCompiler: MarkdownExit | null = null;

function getMetadataCompiler(): MarkdownExit {
  if (metadataCompiler) {
    return metadataCompiler;
  }
  const markdown = new MarkdownExit({ html: true, linkify: true });
  // @ts-expect-error markdown-it-anchor types reference @types/markdown-it, structurally incompatible with markdown-exit
  markdown.use(anchor, {
    permalink: anchor.permalink.ariaHidden({ placement: 'before' }),
  });
  metadataCompiler = markdown;
  return markdown;
}

function extractHeadings(tokens: ReadonlyArray<Token>): ReadonlyArray<Heading> {
  const headings: Array<Heading> = [];
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
    const token = tokens[tokenIndex];
    if (token.type === 'heading_open') {
      const depth = Number(token.tag.slice(1));
      const slug = token.attrGet?.('id') ?? '';
      const inline = tokens[tokenIndex + 1];
      const text = (
        inline?.children
          ?.filter((child) => child.type === 'text' || child.type === 'code_inline')
          .map((child) => child.content)
          .join('') ?? ''
      ).trim();
      headings.push({ depth, slug, text });
    }
  }
  return headings;
}

export type MetadataResult = Readonly<{
  frontmatter: Record<string, unknown>;
  headings: ReadonlyArray<Heading>;
  title: string;
}>;

export function extractMetadata(source: string): MetadataResult {
  const { data: frontmatter, content } = matter(source);
  const compiler = getMetadataCompiler();

  const env: Record<string, unknown> = {};
  const tokens = compiler.parse(content, env);
  const headings = extractHeadings(tokens);

  const title =
    (frontmatter.title as string) ?? headings.find((heading) => heading.depth === 1)?.text ?? '';

  return { frontmatter, headings, title };
}
