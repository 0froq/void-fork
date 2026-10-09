import { readFileSync } from 'node:fs';
import { join } from 'pathslash';
import { getPackageDir } from './agents.ts';

let voidUserAgent: string | undefined;
let cfCliVersion: string | undefined;

export function getVoidUserAgent(): string {
  if (voidUserAgent === undefined) {
    const pkg = JSON.parse(readFileSync(join(getPackageDir(), 'package.json'), 'utf8'));
    voidUserAgent = `void/${pkg.version}`;
  }
  return voidUserAgent;
}

/** cf prepends `cf-cli/` to CLI_VERSION for both API requests and uploads. */
export function getCfCliVersion(): string {
  // Scope this override to cf's child environment; never change Void's process.env.
  // Resolve the installed dependency rather than inheriting a caller's test override.
  if (cfCliVersion === undefined) {
    const pkg = JSON.parse(readFileSync(new URL(import.meta.resolve('cf/package.json')), 'utf8'));
    cfCliVersion = `${pkg.version} ${getVoidUserAgent()}`;
  }
  return cfCliVersion;
}
