import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync } from "vite";

export const SSR_ENTRY_RELATIVE_PATHS = ["src/ssr.entry.ts", "src/ssr.entry.tsx"] as const;

function resolveSsrEntry(root: string): { absolutePath: string; relativePath: string } | null {
  const matches = SSR_ENTRY_RELATIVE_PATHS.map((relativePath) => ({
    relativePath,
    absolutePath: join(root, relativePath),
  })).filter((entry) => existsSync(entry.absolutePath));

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    const names = matches.map((entry) => entry.relativePath).join(", ");
    throw new Error(`Multiple SSR entry files found: ${names}. Keep only one.`);
  }
  return matches[0];
}

export function getSsrEntryPath(root: string): string | null {
  const entry = resolveSsrEntry(root);
  return entry?.absolutePath ?? null;
}

export function hasSsrEntry(root: string): boolean {
  return getSsrEntryPath(root) !== null;
}

/**
 * Validate that src/ssr.entry.ts exports `render`.
 * Returns absolute path when valid, null when entry is absent.
 */
export function validateSsrEntry(root: string): string | null {
  const entry = resolveSsrEntry(root);
  if (!entry) return null;
  const { absolutePath, relativePath } = entry;

  const source = readFileSync(absolutePath, "utf-8");
  if (
    /\bexport\s+(?:async\s+)?function\s+render\b/.test(source) ||
    /\bexport\s+const\s+render\b/.test(source)
  ) {
    return absolutePath;
  }

  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(relativePath, source);
  } catch (err) {
    throw new Error(
      `Invalid SSR entry at ${relativePath}: could not parse source (${err instanceof Error ? err.message : String(err)}).`,
    );
  }

  const program = parsed.program as { body?: any[] };
  const body = program.body ?? [];

  const hasRenderExport = body.some((node) => {
    if (node.type !== "ExportNamedDeclaration") return false;

    const declaration = node.declaration;
    if (declaration?.type === "FunctionDeclaration") {
      return declaration.id?.name === "render";
    }
    if (declaration?.type === "VariableDeclaration") {
      return declaration.declarations.some((decl: any) => decl.id?.name === "render");
    }

    const specifiers = node.specifiers ?? [];
    return specifiers.some((specifier: any) => specifier.exported?.name === "render");
  });

  if (!hasRenderExport) {
    throw new Error(
      `Invalid SSR entry at ${relativePath}: expected \`export function render(request, env)\`.`,
    );
  }

  return absolutePath;
}
