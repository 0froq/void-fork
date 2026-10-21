import { readFileSync } from 'node:fs';
import { basename } from 'pathslash';
import { parseSync } from 'vite';
import {
  isIdentifier,
  type AstExportNamedDeclaration,
  type AstFunctionDeclaration,
  type AstNode,
  type AstProgram,
  type AstVariableDeclaration,
} from '../shared/ast.ts';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);

function collectHttpBindings(node: AstNode | null | undefined, methods: Array<string>): void {
  if (isIdentifier(node)) {
    if (HTTP_METHODS.has(node.name)) {
      methods.push(node.name);
    }
  } else if (node?.type === 'ObjectPattern') {
    for (const property of (node.properties as Array<AstNode> | undefined) ?? []) {
      // Only bound names are exports, not property keys or default value expressions.
      collectHttpBindings(
        (property.type === 'RestElement' ? property.argument : property.value) as
          | AstNode
          | undefined,
        methods,
      );
    }
  } else if (node?.type === 'ArrayPattern') {
    for (const element of (node.elements as Array<AstNode | null> | undefined) ?? []) {
      collectHttpBindings(element, methods);
    }
  } else if (node?.type === 'AssignmentPattern' || node?.type === 'RestElement') {
    collectHttpBindings((node.left ?? node.argument) as AstNode | undefined, methods);
  }
}

/**
 * Detect which HTTP method names are exported from a route file.
 * Scans top-level named exports for identifiers matching HTTP methods.
 */
export function detectHttpExports(absPath: string): Array<string> {
  const code = readFileSync(absPath, 'utf-8');
  const filename = basename(absPath);
  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(filename, code);
  } catch {
    return [];
  }

  const methods: Array<string> = [];
  const program = parsed.program as unknown as AstProgram;

  for (const node of program.body ?? []) {
    if (node.type === 'ExportNamedDeclaration') {
      const declarationNode = node as AstExportNamedDeclaration;
      // `export type { GET }` exports no runtime value — skip the whole statement.
      if (declarationNode.exportKind === 'type') {
        continue;
      }
      // export const GET = ...; export const { GET, POST } = ...; export function POST() { ... }
      const decl = declarationNode.declaration;
      if (decl) {
        if (decl.type === 'VariableDeclaration') {
          for (const declarator of (decl as AstVariableDeclaration).declarations ?? []) {
            collectHttpBindings(declarator.id, methods);
          }
        } else if (decl.type === 'FunctionDeclaration') {
          const fn = decl as AstFunctionDeclaration;
          if (isIdentifier(fn.id) && HTTP_METHODS.has(fn.id.name)) {
            methods.push(fn.id.name);
          }
        }
      }
      // export { GET, POST } (specifiers)
      if (declarationNode.specifiers) {
        for (const spec of declarationNode.specifiers) {
          // `export { type GET }` re-exports a type, not a runtime handler.
          if (spec.exportKind === 'type') {
            continue;
          }
          const exported = isIdentifier(spec.exported)
            ? spec.exported.name
            : isIdentifier(spec.local)
              ? spec.local.name
              : undefined;
          if (exported && HTTP_METHODS.has(exported)) {
            methods.push(exported);
          }
        }
      }
    }
  }

  return methods;
}
