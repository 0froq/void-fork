import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { confirm, isCancel, log } from '@clack/prompts';
import type { ApprovedCloudflareKvBinding } from '@void/deploy-cloudflare';
import { readStoredResourceName } from '@void/deploy-cloudflare';
import { modify, applyEdits } from 'jsonc-parser';
import { join } from 'pathslash';
import { resolveBindingNames, type VoidConfig } from '../config.ts';

/** A configured opt-in authorizes only the cache identity declared before the build. */
export function approvedCloudflareIsrBinding(
  config: VoidConfig,
  rootConfig: Record<string, unknown>,
): Array<ApprovedCloudflareKvBinding> {
  if (
    config.routing?.isr !== true ||
    resolveBindingNames(config.inference?.bindings)?.kv === 'ISR_CACHE'
  ) {
    return [];
  }
  const id = readStoredResourceName(rootConfig, 'kv_namespaces', 'ISR_CACHE', 'id');
  return id && /^[a-f0-9]{32}$/i.test(id) ? [{ binding: 'ISR_CACHE', id }] : [];
}

/** Persist the migration decision in source configuration, not a temporary link marker. */
export async function chooseCloudflareIsr(
  root: string,
  config: VoidConfig,
  options: { interactive: boolean; confirm?: (message: string) => Promise<boolean> },
): Promise<boolean> {
  if (config.routing?.isr !== undefined) {
    return config.routing.isr;
  }
  if (!options.interactive) {
    throw new Error(
      'This migration needs an ISR caching choice. Set routing.isr to true in void.json to provision the KV cache, or false to keep rendering on each request, then rerun `void deploy`.',
    );
  }
  const message =
    'Enable ISR caching for this app? Yes provisions a Cloudflare KV cache; No keeps caching disabled until you change void.json.';
  const enabled = await (
    options.confirm ??
    (async (message) => {
      const answer = await confirm({ message, initialValue: true });
      if (isCancel(answer)) {
        throw new Error('ISR setup cancelled. Rerun `void deploy` to finish linking.');
      }
      return answer === true;
    })
  )(message);
  const path = join(root, 'void.json');
  const source = existsSync(path) ? readFileSync(path, 'utf8') : '{}\n';
  writeFileSync(
    path,
    applyEdits(
      source,
      modify(source, ['routing', 'isr'], enabled, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    ),
  );
  config.routing = { ...config.routing, isr: enabled };
  log.info(
    `Saved routing.isr: ${String(enabled)} in void.json. ISR caching ${enabled ? 'will be enabled in this deployment' : 'stays disabled until you change this setting'}.`,
  );
  return enabled;
}
