import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync } from "vite";

export const SSR_SERVER_ENTRY_RELATIVE_PATHS = ["src/main.ssr.ts", "src/main.ssr.tsx"] as const;
export const SSR_CLIENT_ENTRY_RELATIVE_PATHS = [
  "src/main.client.ts",
  "src/main.client.tsx",
] as const;

interface ResolvedEntry {
  absolutePath: string;
  relativePath: string;
}

export interface SsrEntries {
  server: ResolvedEntry;
  client: ResolvedEntry;
}

export type RevalidateConfig =
  | { type: "none" }
  | { type: "static"; ttl: number }
  | { type: "pathmap"; rules: [string, number][] };

function resolveSingleEntry(
  root: string,
  entries: readonly string[],
  label: string,
): ResolvedEntry | null {
  const matches = entries
    .map((relativePath) => ({
      relativePath,
      absolutePath: join(root, relativePath),
    }))
    .filter((entry) => existsSync(entry.absolutePath));

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
    /\bexport\s+const\s+render\b/.test(source) ||
    /\bexport\s+default\s+(?:defineRender\b|(?:async\s+)?function\b)/.test(source)
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
    if (node.type === "ExportDefaultDeclaration") {
      const declaration = node.declaration;
      if (
        declaration?.type === "FunctionDeclaration" ||
        declaration?.type === "FunctionExpression" ||
        declaration?.type === "ArrowFunctionExpression"
      ) {
        return true;
      }
      if (declaration?.type === "CallExpression") {
        return (
          declaration.callee?.type === "Identifier" && declaration.callee.name === "defineRender"
        );
      }
      return false;
    }
    if (node.type !== "ExportNamedDeclaration") {
      return false;
    }

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
      `Invalid SSR entry at ${relativePath}: expected \`export function render(c, assetTags)\` or \`export default defineRender(...)\`.`,
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

/**
 * Detect revalidate configuration from the SSR server entry.
 * Looks for `export const revalidate = <number>`.
 */
export function getRevalidateConfig(root: string): RevalidateConfig {
  const entry = resolveSingleEntry(root, SSR_SERVER_ENTRY_RELATIVE_PATHS, "SSR");
  if (!entry) return { type: "none" };

  const source = readFileSync(entry.absolutePath, "utf-8");
  if (!source.includes("revalidate")) return { type: "none" };

  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(entry.relativePath, source);
  } catch (err) {
    throw new Error(
      `Invalid SSR entry at ${entry.relativePath}: could not parse source (${err instanceof Error ? err.message : String(err)}).`,
    );
  }

  const program = parsed.program as { body?: any[] };
  const body = program.body ?? [];

  for (const node of body) {
    if (node.type !== "ExportNamedDeclaration") continue;

    const declaration = node.declaration;
    if (declaration?.type !== "VariableDeclaration") continue;

    for (const decl of declaration.declarations ?? []) {
      if (decl.id?.type !== "Identifier" || decl.id.name !== "revalidate") continue;
      const init = decl.init;
      if (!init) continue;

      // Positive numeric literal: `export const revalidate = 60`
      if (init.type === "Literal" && typeof init.value === "number") {
        return { type: "static", ttl: init.value };
      }

      // Infinity identifier: `export const revalidate = Infinity`
      if (init.type === "Identifier" && init.name === "Infinity") {
        return { type: "static", ttl: 31536000 };
      }

      // Negative numeric literal: `export const revalidate = -10`
      // Parsed as UnaryExpression { operator: "-", argument: Literal }
      if (
        init.type === "UnaryExpression" &&
        init.operator === "-" &&
        init.argument?.type === "Literal" &&
        typeof init.argument.value === "number"
      ) {
        throw new Error(
          `Invalid SSR revalidate export at ${entry.relativePath}: value must be a non-negative number.`,
        );
      }

      // Object literal: `export const revalidate = { '/': 60, '*': 30 }`
      if (init.type === "ObjectExpression") {
        const rules: [string, number][] = [];
        for (const prop of init.properties ?? []) {
          if (prop.type !== "Property") {
            throw new Error(
              `Invalid SSR revalidate export at ${entry.relativePath}: object must contain only simple key-value pairs.`,
            );
          }
          // Key must be a string literal
          const key = prop.key;
          if (key.type !== "Literal" || typeof key.value !== "string") {
            throw new Error(
              `Invalid SSR revalidate export at ${entry.relativePath}: object keys must be string literals.`,
            );
          }
          // Value must be a numeric literal or Infinity
          const val = prop.value;
          if (val.type === "Identifier" && val.name === "Infinity") {
            rules.push([key.value as string, 31536000]);
          } else if (val.type === "Literal" && typeof val.value === "number") {
            if (val.value < 0) {
              throw new Error(
                `Invalid SSR revalidate export at ${entry.relativePath}: value for "${key.value}" must be a non-negative number.`,
              );
            }
            rules.push([key.value as string, val.value as number]);
          } else if (
            val.type === "UnaryExpression" &&
            val.operator === "-" &&
            val.argument?.type === "Literal" &&
            typeof val.argument.value === "number"
          ) {
            throw new Error(
              `Invalid SSR revalidate export at ${entry.relativePath}: value for "${key.value}" must be a non-negative number.`,
            );
          } else {
            throw new Error(
              `Invalid SSR revalidate export at ${entry.relativePath}: value for "${key.value}" must be a numeric literal or Infinity.`,
            );
          }
        }
        return { type: "pathmap", rules };
      }

      throw new Error(
        `Invalid SSR revalidate export at ${entry.relativePath}: expected a numeric literal or object (e.g. \`export const revalidate = 60\` or \`export const revalidate = { '/': 60, '*': 30 }\`).`,
      );
    }
  }

  return { type: "none" };
}
