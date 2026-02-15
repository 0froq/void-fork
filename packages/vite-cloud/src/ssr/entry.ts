import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync } from "vite";

export const SSR_SERVER_ENTRY_RELATIVE_PATHS = ["src/ssr.entry.ts", "src/ssr.entry.tsx"] as const;
export const SSR_CLIENT_ENTRY_RELATIVE_PATHS = [
  "src/client.entry.ts",
  "src/client.entry.tsx",
] as const;

interface ResolvedEntry {
  absolutePath: string;
  relativePath: string;
}

export interface SsrEntries {
  server: ResolvedEntry;
  client: ResolvedEntry;
}

function resolveSingleEntry(
  root: string,
  entries: readonly string[],
  label: string,
): ResolvedEntry | null {
  const matches = entries.map((relativePath) => ({
    relativePath,
    absolutePath: join(root, relativePath),
  })).filter((entry) => existsSync(entry.absolutePath));

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    const names = matches.map((entry) => entry.relativePath).join(", ");
    throw new Error(`Multiple ${label} entry files found: ${names}. Keep only one.`);
  }
  return matches[0];
}

export function getSsrServerEntryPath(root: string): string | null {
  const entry = resolveSingleEntry(root, SSR_SERVER_ENTRY_RELATIVE_PATHS, "SSR");
  return entry?.absolutePath ?? null;
}

export function hasSsrEntry(root: string): boolean {
  return getSsrServerEntryPath(root) !== null;
}

function validateServerRenderExport(entry: ResolvedEntry): void {
  const { absolutePath, relativePath } = entry;

  const source = readFileSync(absolutePath, "utf-8");
  if (
    /\bexport\s+(?:async\s+)?function\s+render\b/.test(source) ||
    /\bexport\s+const\s+render\b/.test(source)
  ) {
    return;
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
}

/**
 * Validate SSR mode entry conventions.
 * Returns null when SSR mode is not used.
 */
export function validateSsrEntries(root: string): SsrEntries | null {
  const server = resolveSingleEntry(root, SSR_SERVER_ENTRY_RELATIVE_PATHS, "SSR");
  const client = resolveSingleEntry(root, SSR_CLIENT_ENTRY_RELATIVE_PATHS, "SSR client");

  if (!server && !client) return null;
  if (server && !client) {
    throw new Error(
      `SSR mode requires a client entry. Add one of: ${SSR_CLIENT_ENTRY_RELATIVE_PATHS.join(", ")}`,
    );
  }
  if (!server && client) {
    throw new Error(
      `SSR mode requires a server entry. Add one of: ${SSR_SERVER_ENTRY_RELATIVE_PATHS.join(", ")}`,
    );
  }

  validateServerRenderExport(server!);
  return {
    server: server!,
    client: client!,
  };
}

export function validateSsrEntry(root: string): string | null {
  return validateSsrEntries(root)?.server.absolutePath ?? null;
}
