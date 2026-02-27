import type { PageScanResult, LayoutDefinition, NamedLayoutDefinition } from "void/pages";
import { resolveNamedLayout } from "void/pages";

/**
 * Generates the component import map and layout tree as code strings.
 * Used by both SSR renderer and client entry virtual modules.
 */
export function generateComponentManifest(scan: PageScanResult, pagesDir: string): string {
  const lines: string[] = [];

  // Component lazy imports
  lines.push("const components = {");
  for (const page of scan.pages) {
    const importPath = `${pagesDir}/${page.componentPath}`;
    lines.push(
      `  ${JSON.stringify(page.componentId)}: () => import(${JSON.stringify(importPath)}),`,
    );
  }
  for (const layout of scan.layouts) {
    const importPath = `${pagesDir}/${layout.filePath}`;
    const layoutId = layout.directory ? `${layout.directory}/layout` : "layout";
    lines.push(`  ${JSON.stringify(layoutId)}: () => import(${JSON.stringify(importPath)}),`);
  }
  for (const nl of scan.namedLayouts) {
    const importPath = `${pagesDir}/${nl.filePath}`;
    const layoutId = nl.directory ? `${nl.directory}/_layouts/${nl.name}` : `_layouts/${nl.name}`;
    lines.push(`  ${JSON.stringify(layoutId)}: () => import(${JSON.stringify(importPath)}),`);
  }
  lines.push("};");

  // Layout tree (component ID → ordered layout IDs)
  lines.push("const layoutTree = {");
  for (const page of scan.pages) {
    const chain = resolveLayoutIds(page, scan.layouts, scan.namedLayouts);
    if (chain.length > 0) {
      lines.push(`  ${JSON.stringify(page.componentId)}: ${JSON.stringify(chain)},`);
    }
  }
  lines.push("};");

  // Route metadata (sparse — only island pages)
  lines.push("const routeMeta = {");
  for (const page of scan.pages) {
    if (page.island) {
      lines.push(`  ${JSON.stringify(page.componentId)}: { island: true },`);
    }
  }
  lines.push("};");

  // Route pattern table for client-side URL matching
  lines.push("const routes = [");
  for (const page of scan.pages) {
    const regex = patternToRegex(page.pattern);
    lines.push(`  { pattern: ${regex}, id: ${JSON.stringify(page.componentId)} },`);
  }
  lines.push("];");

  lines.push(`function matchRoute(url) {
  const path = new URL(url, "http://x").pathname;
  for (const r of routes) {
    if (r.pattern.test(path)) return r.id;
  }
  return null;
}`);

  return lines.join("\n");
}

function patternToRegex(pattern: string): string {
  const re = pattern
    .replace(/:[^/{}]+\{\.\+\}/g, "(.+)") // catch-all :path{.+}
    .replace(/:[^/]+/g, "([^/]+)"); // dynamic :param
  return `/^${re.replace(/\//g, "\\/")}$/`;
}

function resolveLayoutIds(
  page: { componentId: string; layout?: string | false },
  layouts: LayoutDefinition[],
  namedLayouts: NamedLayoutDefinition[],
): string[] {
  if (page.layout === false) return [];

  // Build default chain
  const parts = page.componentId.split("/");
  const defaultChain: string[] = [];
  const root = layouts.find((l) => l.directory === "");
  if (root) defaultChain.push("layout");
  let dir = "";
  for (let i = 0; i < parts.length - 1; i++) {
    dir = dir ? `${dir}/${parts[i]}` : parts[i];
    if (layouts.find((l) => l.directory === dir)) defaultChain.push(`${dir}/layout`);
  }

  if (page.layout === undefined) return defaultChain;

  const isExclusive = page.layout.startsWith("!");
  const name = isExclusive ? page.layout.slice(1) : page.layout;
  if (name.startsWith(".") || name.startsWith("/")) return defaultChain;

  const resolved = resolveNamedLayout(name, page.componentId, namedLayouts);
  if (!resolved) return defaultChain;

  const namedId = resolved.directory
    ? `${resolved.directory}/_layouts/${resolved.name}`
    : `_layouts/${resolved.name}`;

  if (isExclusive) return [namedId];
  if (defaultChain.length === 0) return [namedId];

  const chain = [...defaultChain];
  chain[chain.length - 1] = namedId;
  return chain;
}
