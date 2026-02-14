import { parseSync } from "vite";
import { walk } from "oxc-walker";

export interface InferredBindings {
  needsD1: boolean;
  needsKV: boolean;
  needsR2: boolean;
}

/**
 * Infer which Cloudflare bindings a source file uses by walking its AST.
 * Looks for member expressions like:
 *   *.env.DB      → needsD1
 *   *.env.KV      → needsKV
 *   *.env.STORAGE  → needsR2
 */
export function inferBindingsFromSource(code: string, filename: string): InferredBindings {
  const result: InferredBindings = {
    needsD1: false,
    needsKV: false,
    needsR2: false,
  };

  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(filename, code);
  } catch {
    return result;
  }

  walk(parsed.program, {
    enter(node: any) {
      if (node.type !== "MemberExpression") return;
      if (node.computed) return;

      const property = node.property;
      if (property?.type !== "Identifier") return;

      // Check if the object is *.env (i.e., a MemberExpression with .env)
      const obj = node.object;
      if (obj?.type !== "MemberExpression") return;
      if (obj.property?.type !== "Identifier" || obj.property.name !== "env") return;

      switch (property.name) {
        case "DB":
          result.needsD1 = true;
          break;
        case "KV":
          result.needsKV = true;
          break;
        case "STORAGE":
          result.needsR2 = true;
          break;
      }
    },
  });

  return result;
}

/**
 * Merge multiple InferredBindings into a single result (union).
 */
export function mergeBindings(bindings: InferredBindings[]): InferredBindings {
  return {
    needsD1: bindings.some((b) => b.needsD1),
    needsKV: bindings.some((b) => b.needsKV),
    needsR2: bindings.some((b) => b.needsR2),
  };
}
