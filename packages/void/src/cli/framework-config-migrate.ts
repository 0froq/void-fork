import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseExpressionAt } from 'acorn';
import { dirname, join } from 'pathslash';

const GENERATED_PATH = './.void-wrangler.jsonc';
const CONFIG_FILES = [
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mts',
  'vite.config.mjs',
  'vite.config.cts',
  'vite.config.cjs',
  'svelte.config.ts',
  'svelte.config.js',
  'astro.config.ts',
  'astro.config.mjs',
  'astro.config.js',
  'astro.config.mts',
  'nuxt.config.ts',
  'nuxt.config.mjs',
  'nuxt.config.js',
  'nuxt.config.mts',
];

export type FrameworkConfigPatch = { file: string; original: string; updated: string };

type Expression = {
  type: string;
  start: number;
  end: number;
  name?: string;
  value?: unknown;
  callee?: Expression;
  arguments?: Array<Expression>;
  properties?: Array<
    Expression & { key?: Expression; value?: Expression; computed?: boolean; kind?: string }
  >;
};
type Edit = { start: number; end: number; text: string };

function property(object: Expression, key: string): Expression | undefined {
  return object.properties?.find(
    (item) =>
      item.type === 'Property' &&
      !item.computed &&
      item.kind === 'init' &&
      (item.key?.name === key || item.key?.value === key),
  )?.value;
}

function setPath(object: Expression, key: string, file: string, edits: Array<Edit>): void {
  const value = property(object, key);
  if (!value) {
    edits.push({
      start: object.start + 1,
      end: object.start + 1,
      text: `${key}: '${GENERATED_PATH}', `,
    });
  } else if (
    value.type === 'Literal' &&
    typeof value.value === 'string' &&
    (value.value === 'wrangler.jsonc' ||
      value.value === './wrangler.jsonc' ||
      value.value === 'wrangler.json' ||
      value.value === './wrangler.json' ||
      value.value === GENERATED_PATH)
  ) {
    edits.push({ start: value.start, end: value.end, text: `'${GENERATED_PATH}'` });
  } else {
    throw new Error(
      `migrate: Update ${file} to pass ${GENERATED_PATH} to its Cloudflare adapter before removing the root Wrangler config.`,
    );
  }
}

function patchAdapterCall(
  source: string,
  identifier: string,
  file: string,
  kind: 'svelte' | 'astro',
): string {
  const candidates = [...source.matchAll(new RegExp(`\\b${identifier}\\s*\\(`, 'g'))];
  const calls: Array<Expression> = [];
  for (const candidate of candidates) {
    try {
      const node = parseExpressionAt(source, candidate.index!, {
        ecmaVersion: 'latest',
        sourceType: 'module',
      }) as Expression;
      if (node.type === 'CallExpression' && node.callee?.name === identifier) {
        calls.push(node);
      }
    } catch {
      // An authored TypeScript expression may need a manual adapter update.
    }
  }
  if (calls.length !== 1) {
    throw new Error(
      `migrate: Update ${file} to pass ${GENERATED_PATH} to its Cloudflare adapter before removing the root Wrangler config.`,
    );
  }
  const call = calls[0]!;
  const args = call.arguments ?? [];
  if (args.length > 1 || (args.length === 1 && args[0]?.type !== 'ObjectExpression')) {
    throw new Error(
      `migrate: Update ${file} to pass ${GENERATED_PATH} to its Cloudflare adapter before removing the root Wrangler config.`,
    );
  }
  if (args.length === 0) {
    const options =
      kind === 'svelte'
        ? `{ config: '${GENERATED_PATH}', platformProxy: { configPath: '${GENERATED_PATH}' } }`
        : `{ configPath: '${GENERATED_PATH}' }`;
    return `${source.slice(0, call.end - 1)}${options}${source.slice(call.end - 1)}`;
  }
  const options = args[0]!;
  const edits: Array<Edit> = [];
  if (kind === 'astro') {
    setPath(options, 'configPath', file, edits);
  } else {
    setPath(options, 'config', file, edits);
    const proxy = property(options, 'platformProxy');
    if (!proxy) {
      edits.push({
        start: options.start + 1,
        end: options.start + 1,
        text: `platformProxy: { configPath: '${GENERATED_PATH}' }, `,
      });
    } else if (proxy.type === 'ObjectExpression') {
      setPath(proxy, 'configPath', file, edits);
    } else {
      throw new Error(
        `migrate: Update ${file} to pass ${GENERATED_PATH} to its Cloudflare adapter before removing the root Wrangler config.`,
      );
    }
  }
  return edits
    .sort((a, b) => b.start - a.start)
    .reduce(
      (result, edit) => `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`,
      source,
    );
}

/** Plan only edits whose adapter call can be identified without changing authored options. */
export function planFrameworkConfigMigration(root: string): Array<FrameworkConfigPatch> {
  const patches: Array<FrameworkConfigPatch> = [];
  for (const file of CONFIG_FILES) {
    const path = join(root, file);
    if (!existsSync(path)) {
      continue;
    }
    const original = readFileSync(path, 'utf8');
    let updated = original;

    const svelteImport = /import\s+(\w+)\s+from\s+['"]@sveltejs\/adapter-cloudflare['"]/.exec(
      original,
    );
    if (svelteImport) {
      const identifier = svelteImport[1]!;
      updated = patchAdapterCall(updated, identifier, file, 'svelte');
    } else if (
      /(?:from\s*['"]|require\(\s*['"]|import\(\s*['"])@sveltejs\/adapter-cloudflare['"]/.test(
        original,
      )
    ) {
      throw new Error(
        `migrate: Update ${file} to pass ${GENERATED_PATH} to its Cloudflare adapter before removing the root Wrangler config.`,
      );
    }

    const astroImport = /import\s+(\w+)\s+from\s+['"]@astrojs\/cloudflare['"]/.exec(original);
    if (astroImport) {
      const identifier = astroImport[1]!;
      updated = patchAdapterCall(updated, identifier, file, 'astro');
    } else if (
      /(?:from\s*['"]|require\(\s*['"]|import\(\s*['"])@astrojs\/cloudflare['"]/.test(original)
    ) {
      throw new Error(
        `migrate: Update ${file} to pass ${GENERATED_PATH} to its Cloudflare adapter before removing the root Wrangler config.`,
      );
    }

    if (original.includes('nitro-cloudflare-dev') && !original.includes('cloudflareDev:')) {
      const preset = /preset:\s*['"]cloudflare-module['"]\s*,/g;
      const matches = [...updated.matchAll(preset)];
      if (matches.length !== 1) {
        throw new Error(
          `migrate: Set nitro.cloudflareDev.configPath to ${GENERATED_PATH} in ${file} before removing the root Wrangler config.`,
        );
      }
      updated = updated.replace(
        preset,
        (match) => `${match}\n        cloudflareDev: { configPath: '${GENERATED_PATH}' },`,
      );
    } else if (
      original.includes('nitro-cloudflare-dev') &&
      original.includes('cloudflareDev:') &&
      !original.includes(`configPath: '${GENERATED_PATH}'`) &&
      !original.includes(`configPath: "${GENERATED_PATH}"`)
    ) {
      const rootPath = /configPath:\s*(['"])(?:\.\/)?wrangler\.jsonc?\1/g;
      const matches = [...updated.matchAll(rootPath)];
      if (matches.length !== 1) {
        throw new Error(
          `migrate: Set nitro.cloudflareDev.configPath to ${GENERATED_PATH} in ${file} before removing the root Wrangler config.`,
        );
      }
      updated = updated.replace(rootPath, `configPath: '${GENERATED_PATH}'`);
    }

    if (updated !== original) {
      patches.push({ file, original, updated });
    }
  }
  return patches;
}

export function applyFrameworkConfigMigration(
  root: string,
  patches: Array<FrameworkConfigPatch>,
): boolean {
  for (const patch of patches) {
    const path = join(root, patch.file);
    if (readFileSync(path, 'utf8') !== patch.original) {
      throw new Error(`migrate: ${patch.file} changed during migration. Retry.`);
    }
    const backup = join(root, '.void', 'config-migration', patch.file);
    mkdirSync(dirname(backup), { recursive: true });
    if (!existsSync(backup)) {
      writeFileSync(backup, patch.original, { flag: 'wx' });
    }
    writeFileSync(path, patch.updated);
  }
  return patches.length > 0;
}

export function migrateFrameworkAdapterPaths(root: string): boolean {
  if (!existsSync(join(root, 'void.config.ts'))) {
    return false;
  }
  return applyFrameworkConfigMigration(root, planFrameworkConfigMigration(root));
}
