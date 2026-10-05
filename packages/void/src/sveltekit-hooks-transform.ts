import MagicString from 'magic-string';
import { parseSync } from 'vite';
import {
  isIdentifier,
  type AstExportNamedDeclaration,
  type AstNode,
  type AstProgram,
} from './shared/ast.ts';

/** Add Void's dev bindings to SvelteKit's generated get_hooks function. */
export function injectSvelteKitHooks(
  code: string,
  id: string,
  dispatchPath: string,
): { code: string; map: ReturnType<MagicString['generateMap']> } | undefined {
  if (!code.includes('get_hooks')) {
    return undefined;
  }
  const program = parseSync(id, code).program as unknown as AstProgram;
  const hooks = (program.body ?? [])
    .filter((node) => node.type === 'ExportNamedDeclaration')
    .map((node) => (node as AstExportNamedDeclaration).declaration)
    .filter((node): node is AstNode => {
      const name = node?.id as AstNode | undefined;
      return (
        node?.type === 'FunctionDeclaration' && isIdentifier(name) && name.name === 'get_hooks'
      );
    });
  if (hooks.length !== 1) {
    throw new Error('sveltekit: Expected one generated get_hooks function.');
  }
  const body = hooks[0]!.body as AstNode | undefined;
  const returns =
    (body?.body as Array<AstNode> | undefined)?.filter(
      (node) =>
        node.type === 'ReturnStatement' &&
        (node.argument as AstNode | undefined)?.type === 'ObjectExpression',
    ) ?? [];
  if (
    body?.type !== 'BlockStatement' ||
    body.start === undefined ||
    returns.length !== 1 ||
    returns[0]?.start === undefined
  ) {
    throw new Error('sveltekit: Expected one object return in generated get_hooks.');
  }
  const ms = new MagicString(code);
  ms.appendLeft(
    body.start + 1,
    `\n  const { withRuntimeEnv } = await import("void/_env");\n  const { handleDevTrigger } = await import(${JSON.stringify(dispatchPath)});`,
  );
  ms.appendLeft(
    returns[0].start,
    `const __origHandle = handle ?? (({ event, resolve }) => resolve(event));\n` +
      `  handle = async ({ event, resolve }) => {\n` +
      `    const __voidEnv = event.platform?.env ?? (await import('cloudflare:workers')).env;\n` +
      `    return withRuntimeEnv(__voidEnv, async () => {\n` +
      `    const __triggerResp = await handleDevTrigger(event.request, __voidEnv, undefined);\n` +
      `    if (__triggerResp) return __triggerResp;\n` +
      `    return __origHandle({ event, resolve });\n` +
      `    });\n  };\n  `,
  );
  return { code: ms.toString(), map: ms.generateMap({ hires: true }) };
}
