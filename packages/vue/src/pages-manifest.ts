import type { PageScanResult, LayoutDefinition } from "vite-cloud/pages";

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
  lines.push("};");

  // Layout tree (component ID → ordered layout IDs)
  lines.push("const layoutTree = {");
  for (const page of scan.pages) {
    const chain = resolveLayoutIds(page.componentId, scan.layouts);
    if (chain.length > 0) {
      lines.push(`  ${JSON.stringify(page.componentId)}: ${JSON.stringify(chain)},`);
    }
  }
  lines.push("};");

  return lines.join("\n");
}

function resolveLayoutIds(componentId: string, layouts: LayoutDefinition[]): string[] {
  const parts = componentId.split("/");
  const chain: string[] = [];
  const root = layouts.find((l) => l.directory === "");
  if (root) chain.push("layout");
  let dir = "";
  for (let i = 0; i < parts.length - 1; i++) {
    dir = dir ? `${dir}/${parts[i]}` : parts[i];
    const layout = layouts.find((l) => l.directory === dir);
    if (layout) chain.push(`${dir}/layout`);
  }
  return chain;
}
