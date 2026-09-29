import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'pathslash';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { writeProvisionedWranglerConfig } from '../../src/cli/wrangler.ts';
import {
  materializeCloudflareConfig,
  persistCloudflareConfig,
  seedCloudflareConfig,
} from '../../src/cloudflare-config.ts';

const root = join(import.meta.dirname, '.tmp-cloudflare-config-test');

function config(source: string): void {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'void.config.ts'), source);
}

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('materializeCloudflareConfig', () => {
  it('passes through custom Cloudflare settings and keeps the generated file outside Wrangler discovery', () => {
    config(
      'export default { cloudflare: { name: "app", vars: { FOO: "bar" }, limits: { cpu_ms: 50 } } };\n',
    );
    const path = materializeCloudflareConfig(root);
    expect(path).toBe(join(root, '.void-wrangler.jsonc'));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      name: 'app',
      vars: { FOO: 'bar' },
      limits: { cpu_ms: 50 },
    });
    expect(existsSync(join(root, 'wrangler.jsonc'))).toBe(false);
    expect(existsSync(join(root, 'void.lock.json'))).toBe(false);
  });

  it('retains provisioned fields while explicit authored changes win', () => {
    config('export default { cloudflare: { name: "app", vars: { FOO: "old" } } };\n');
    const path = materializeCloudflareConfig(root);
    writeFileSync(
      path,
      JSON.stringify({ name: 'app', account_id: '123', vars: { FOO: 'old', GENERATED: 'yes' } }),
    );
    persistCloudflareConfig(root);
    writeFileSync(
      join(root, 'void.config.ts'),
      'export default { cloudflare: { name: "new", vars: { FOO: "new" } } };\n',
    );
    expect(JSON.parse(readFileSync(materializeCloudflareConfig(root), 'utf8'))).toEqual({
      name: 'new',
      account_id: '123',
      vars: { FOO: 'new', GENERATED: 'yes' },
    });
  });

  it('restores exact JSONC provenance from a migration seed', () => {
    config('export default { cloudflare: { name: "app" } };\n');
    const raw =
      '// void:published-traffic:v1:eyJ3b3JrZXJzX2RldiI6ZmFsc2UsInByZXZpZXdfdXJscyI6ZmFsc2UsInJvdXRlcyI6W119\n{ "name": "app" }\n';
    seedCloudflareConfig(root, { name: 'app' }, raw);
    expect(readFileSync(materializeCloudflareConfig(root), 'utf8')).toBe(raw);
  });

  it('rejects a root Wrangler file alongside typed config', () => {
    config('export default {};\n');
    writeFileSync(join(root, 'wrangler.jsonc'), '{}');
    expect(() => materializeCloudflareConfig(root)).toThrow('Run `void migrate`');
  });

  it('records provisioned settings and reconstructs them from the checked-in files', () => {
    config('export default { cloudflare: { name: "app", vars: { CUSTOM: "yes" } } };\n');
    const path = materializeCloudflareConfig(root);
    writeProvisionedWranglerConfig(root, {
      accountId: 'account-1',
      compatibilityDate: '2026-02-24',
    });
    expect(existsSync(join(root, 'void.lock.json'))).toBe(true);
    rmSync(path);
    expect(JSON.parse(readFileSync(materializeCloudflareConfig(root), 'utf8'))).toEqual({
      name: 'app',
      vars: { CUSTOM: 'yes' },
      account_id: 'account-1',
      compatibility_date: '2026-02-24',
    });
    expect(existsSync(join(root, 'wrangler.jsonc'))).toBe(false);
  });
});
