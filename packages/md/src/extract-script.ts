const SCRIPT_RE = /^<script\b[^>]*>([\s\S]*?)<\/script>\s*\n?/;
const ISLAND_IMPORT_RE =
  /import\s+(\w+)\s+from\s+("[^"]+"|'[^']+')\s+with\s*\{\s*island\s*:\s*("[^"]+"|'[^']+')\s*\}/g;

export interface IslandImport {
  name: string;
  specifier: string;
  strategy: string;
}

export interface ScriptExtraction {
  script: string | null;
  body: string;
  islandImports: IslandImport[];
}

export function extractScript(source: string): ScriptExtraction {
  const match = source.match(SCRIPT_RE);
  if (!match) return { script: null, body: source, islandImports: [] };

  const script = match[1].trim();
  const body = source.slice(match[0].length);

  const islandImports: IslandImport[] = [];
  let m;
  while ((m = ISLAND_IMPORT_RE.exec(script)) !== null) {
    islandImports.push({
      name: m[1],
      specifier: m[2].slice(1, -1),
      strategy: m[3].slice(1, -1),
    });
  }

  return { script, body, islandImports };
}
