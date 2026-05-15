import type { CompileResult } from './compile.ts';
import { toIslandId } from './emit-shared.ts';
import type { IslandImport } from './extract-script.ts';

export function emitVueComponent(result: CompileResult): string {
  return `
import { defineComponent, createStaticVNode, provide } from "vue";

const __frontmatter = ${JSON.stringify(result.frontmatter)};
const __headings = ${JSON.stringify(result.headings)};
const __html = ${JSON.stringify(result.html)};

export const frontmatter = __frontmatter;
export const headings = __headings;

export default defineComponent({
  setup() {
    provide("__void_frontmatter", __frontmatter);
    return () => createStaticVNode(__html, 1);
  }
});
`;
}

// Match self-closing uppercase tags: <Counter />, <Counter attr="val" />
// and paired uppercase tags: <Counter>...</Counter>
const ISLAND_TAG_RE =
  /<([A-Z]\w*)\s*((?:[^>/"']|"[^"]*"|'[^']*')*)\/\s*>|<([A-Z]\w*)\s*((?:[^>/"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/\3\s*>/g;

type IslandMatch = {
  name: string;
  start: number;
  end: number;
  attrs: string;
  children: string;
};

function findIslandTags(html: string, names: Set<string>): ReadonlyArray<IslandMatch> {
  const matches: Array<IslandMatch> = [];
  let tagMatch: RegExpExecArray | null;
  ISLAND_TAG_RE.lastIndex = 0;
  while ((tagMatch = ISLAND_TAG_RE.exec(html)) !== null) {
    const name = tagMatch[1] ?? tagMatch[3];
    if (names.has(name)) {
      matches.push({
        name,
        start: tagMatch.index,
        end: tagMatch.index + tagMatch[0].length,
        attrs: (tagMatch[2] ?? tagMatch[4] ?? '').trim(),
        children: tagMatch[5] ?? '',
      });
    }
  }
  return matches;
}

function parseAttrs(attrStr: string): Record<string, string> {
  const result: Record<string, string> = {};
  const attrRe = /(\w[\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = attrRe.exec(attrStr)) !== null) {
    result[attrMatch[1]] = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
  }
  return result;
}

export function emitVueComponentWithIslands(
  result: CompileResult,
  islandImports: ReadonlyArray<IslandImport>,
): string {
  const nameSet = new Set(islandImports.map((islandImport) => islandImport.name));
  const islandTags = findIslandTags(result.html, nameSet);

  let code = `import { defineComponent, h, createStaticVNode, provide } from "vue";\n`;

  // Import raw island components
  for (let islandIndex = 0; islandIndex < islandImports.length; islandIndex++) {
    const islandImport = islandImports[islandIndex];
    code += `import _raw_island_${islandIndex} from ${JSON.stringify(islandImport.specifier)};\n`;
  }

  // Create island wrapper components
  for (let islandIndex = 0; islandIndex < islandImports.length; islandIndex++) {
    const islandImport = islandImports[islandIndex];
    code += `const ${islandImport.name} = { inheritAttrs: false, render() {
  const props = this.$attrs;
  return h("div", {
    "data-island": ${JSON.stringify(toIslandId(islandImport))},
    "data-props": JSON.stringify(props),
    "data-hydrate": ${JSON.stringify(islandImport.strategy)}
  }, h(_raw_island_${islandIndex}, props));
}};\n`;
  }

  // Build render function that interleaves static segments and island vnodes
  const vnodes: Array<string> = [];
  let cursor = 0;

  for (const tag of islandTags) {
    // Static HTML before this island tag
    if (tag.start > cursor) {
      const segment = result.html.slice(cursor, tag.start);
      if (segment.trim()) {
        vnodes.push(`createStaticVNode(${JSON.stringify(segment)}, 1)`);
      }
    }

    const attrs = parseAttrs(tag.attrs);
    const propsStr = Object.keys(attrs).length > 0 ? JSON.stringify(attrs) : 'null';
    // Use the wrapper component
    vnodes.push(`h(${tag.name}, ${propsStr})`);

    cursor = tag.end;
  }

  // Remaining HTML after last island tag
  if (cursor < result.html.length) {
    const segment = result.html.slice(cursor);
    if (segment.trim()) {
      vnodes.push(`createStaticVNode(${JSON.stringify(segment)}, 1)`);
    }
  }

  code += `
const __frontmatter = ${JSON.stringify(result.frontmatter)};
const __headings = ${JSON.stringify(result.headings)};

export const frontmatter = __frontmatter;
export const headings = __headings;

export default defineComponent({
  setup() {
    provide("__void_frontmatter", __frontmatter);
    return () => [
      ${vnodes.join(',\n      ')}
    ];
  }
});
`;

  return code;
}
