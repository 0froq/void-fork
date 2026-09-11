import { isNodeTarget, type VoidConfig } from '../../config.ts';
import { scanJobsSync } from '../../crons/scan.ts';
import { scanDurableObjectModules } from '../../durable/scan.ts';
import { detectFramework } from '../../plugin-inference.ts';
import { assertNoRootSourceConventionConflicts, resolveProjectPaths } from '../../project-paths.ts';
import { scanWebSocketRoutesSync } from '../../router/websocket.ts';
import { validateSsrEntry } from '../../ssr/entry.ts';
import { detectPreset, hasBackendFiles } from '../preset.ts';
import { syncWranglerDurableObjects } from '../wrangler.ts';

export type CloudflareDeployAppOptions = {
  dir?: string;
  spa?: boolean;
};

export type CloudflareDeployAppClassification =
  | { supported: true }
  | { supported: false; reason: string };

/**
 * Narrow native Cloudflare deploys to app shapes whose emitted Worker artifact
 * the current verifier understands. This runs before any account operation.
 */
export function classifyCloudflareDeployApp(
  root: string,
  voidConfig: VoidConfig,
  options: CloudflareDeployAppOptions,
): CloudflareDeployAppClassification {
  if (isNodeTarget(voidConfig.target)) {
    return unsupported(
      [
        `deploy: --platform cloudflare is not supported for the "${voidConfig.target}" target.`,
        'This backend deploys Cloudflare Workers only. Deploy a node/bun/deno build with its',
        'own host/runtime, or use the default Cloudflare target for --platform cloudflare.',
      ].join('\n'),
    );
  }

  const framework = detectFramework(root);
  if (framework) {
    return unsupported(
      [
        `deploy: --platform cloudflare does not yet support framework SSR (${framework.name}).`,
        'v1 deploys full Void apps only. Deploy this framework with `void deploy` (the managed',
        'platform) or the framework’s own Cloudflare adapter. Framework SSR support for this',
        'backend is a follow-up.',
      ].join('\n'),
    );
  }

  const staticPreset = detectPreset(root, { dir: options.dir, spa: options.spa });
  const configuredStatic =
    voidConfig.inference?.appType === 'static' || voidConfig.inference?.appType === 'spa';
  if (staticPreset || configuredStatic || options.dir || options.spa) {
    const appType = staticPreset?.appType ?? (options.spa ? 'spa' : 'static');
    return unsupported(
      [
        `deploy: --platform cloudflare does not yet support ${appType} (static-asset) apps.`,
        'The Cloudflare backend v1 deploys full Void apps (worker-bearing) on the Cloudflare',
        'Workers target. Deploy this app with `void deploy` (the managed platform), or host',
        'the built assets on Cloudflare Pages / any static host.',
      ].join('\n'),
    );
  }

  if (!hasBackendFiles(root)) {
    return unsupported(
      [
        'deploy: --platform cloudflare found no Void backend to deploy.',
        'A full Void app has at least one of: routes/, pages/, middleware, crons/, queues/,',
        'or an SSR entry. Add your server code, or use `void deploy` for a static site.',
      ].join('\n'),
    );
  }

  const paths = resolveProjectPaths(root, voidConfig);
  try {
    assertNoRootSourceConventionConflicts(paths);
    validateSsrEntry(root, paths);
    scanJobsSync(root, paths.cronsDir);
    syncWranglerDurableObjects(root, scanDurableObjectModules(root));
  } catch (error) {
    return unsupported(`deploy: ${getErrorMessage(error)}`);
  }

  if (scanWebSocketRoutesSync(root, paths, 'prod').length > 0) {
    return unsupported(
      [
        'deploy: --platform cloudflare does not yet support WebSocket / Durable Object routes.',
        'A `.ws.ts` route makes the build emit a key-value-backed Durable Object namespace',
        '(a `new_classes` migration), which a fresh Cloudflare account (and every Workers Free',
        'account) refuses to create. Deploy this app with `void deploy` (the managed platform).',
        'SQLite-backed WebSocket support for this backend is a follow-up.',
      ].join('\n'),
    );
  }

  return { supported: true };
}

function unsupported(reason: string): CloudflareDeployAppClassification {
  return { supported: false, reason };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
