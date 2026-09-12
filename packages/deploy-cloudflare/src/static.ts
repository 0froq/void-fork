import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AssetConfig, HeaderRule, RedirectRule } from '@void/deploy-core';
import { applyEdits, modify } from 'jsonc-parser';
import { dirname, join, relative, resolve } from 'pathslash';

export type CloudflareStaticDeployConfig = Readonly<{
  configPath: string;
  name: string;
  accountId: string;
  main: string;
  assetsDirectory: string;
  compatibilityDate: string;
  assetConfig: AssetConfig;
}>;

/** Generate the deterministic thin Worker entry bundled by Wrangler. */
export function renderCloudflareStaticEntry(options: {
  runtimeImport?: string;
  headerRules?: ReadonlyArray<HeaderRule>;
  redirectRules?: ReadonlyArray<RedirectRule>;
  fallbackRules?: ReadonlyArray<RedirectRule>;
}): string {
  const config = JSON.stringify({
    ...(options.headerRules?.length ? { headerRules: options.headerRules } : {}),
    ...(options.redirectRules?.length ? { redirectRules: options.redirectRules } : {}),
    ...(options.fallbackRules?.length ? { fallbackRules: options.fallbackRules } : {}),
  });
  return [
    `import { createStaticEdgeHandler } from ${JSON.stringify(options.runtimeImport ?? '@void/edge')};`,
    `export default createStaticEdgeHandler(${config});`,
    '',
  ].join('\n');
}

/**
 * Copy static assets into Void's deploy area without Cloudflare's reserved routing files.
 *
 * Void has already compiled the root `_headers` and `_redirects` files into the thin edge
 * Worker. Wrangler parses those files independently of `.assetsignore`, so uploading the source
 * directory would apply every rule twice and can reject valid Void fallbacks as redirect loops.
 */
export function stageCloudflareStaticAssets(options: {
  sourceDirectory: string;
  destinationDirectory: string;
}): void {
  const sourceDirectory = resolve(options.sourceDirectory);
  const destinationDirectory = resolve(options.destinationDirectory);
  if (sourceDirectory === destinationDirectory) {
    throw new Error(
      'Cloudflare static asset staging requires distinct source and destination directories.',
    );
  }

  const reserved = new Set([
    join(sourceDirectory, '_headers'),
    join(sourceDirectory, '_redirects'),
  ]);
  const isInsideDestination = (path: string): boolean => {
    const fromDestination = relative(destinationDirectory, resolve(path));
    return (
      fromDestination === '' || (fromDestination !== '..' && !fromDestination.startsWith('../'))
    );
  };

  rmSync(destinationDirectory, { recursive: true, force: true });
  mkdirSync(dirname(destinationDirectory), { recursive: true });
  cpSync(sourceDirectory, destinationDirectory, {
    recursive: true,
    filter(path) {
      const absolute = resolve(path);
      return !reserved.has(absolute) && !isInsideDestination(absolute);
    },
  });
}

/**
 * Persist the mutable Cloudflare target state without replacing comments,
 * Durable Object migrations, resource ids, or unrelated user configuration.
 */
export function writeCloudflareStaticDeployConfig(options: CloudflareStaticDeployConfig): boolean {
  const initial = existsSync(options.configPath)
    ? readFileSync(options.configPath, 'utf-8')
    : '{}\n';
  let content = initial;
  const upsert = (path: Array<string>, value: unknown): void => {
    const edits = modify(content, path, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
    });
    content = applyEdits(content, edits);
  };

  upsert(['name'], options.name);
  upsert(['account_id'], options.accountId);
  upsert(['main'], options.main);
  upsert(['compatibility_date'], options.compatibilityDate);
  upsert(['assets', 'directory'], options.assetsDirectory);
  upsert(['assets', 'binding'], 'ASSETS');
  upsert(['assets', 'run_worker_first'], true);
  upsert(['assets', 'not_found_handling'], options.assetConfig.not_found_handling ?? 'none');
  upsert(['assets', 'html_handling'], options.assetConfig.html_handling ?? 'auto-trailing-slash');

  if (content !== initial) {
    writeFileSync(options.configPath, content);
    return true;
  }
  return false;
}
