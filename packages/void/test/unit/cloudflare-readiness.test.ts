import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { describe, expect, it } from 'vite-plus/test';
import {
  rememberCloudflareWorkersDevSubdomain,
  resolveCloudflareWorkersDevSubdomain,
} from '../../src/cli/cloudflare-readiness.ts';

describe('Cloudflare readiness state', () => {
  it('prefers and normalizes the environment override', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-readiness-'));
    expect(
      resolveCloudflareWorkersDevSubdomain(root, {
        CLOUDFLARE_WORKERS_SUBDOMAIN: 'Developer-Platform-Experience.workers.dev',
      }),
    ).toBe('developer-platform-experience');
  });

  it('accepts the FedRAMP workers.dev subdomain form', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-readiness-'));
    expect(
      resolveCloudflareWorkersDevSubdomain(root, {
        CLOUDFLARE_WORKERS_SUBDOMAIN: 'my-team.fed.workers.dev',
      }),
    ).toBe('my-team.fed');
  });

  it('rejects an invalid environment override', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-readiness-'));
    expect(() =>
      resolveCloudflareWorkersDevSubdomain(root, {
        CLOUDFLARE_WORKERS_SUBDOMAIN: 'https://example.com/path',
      }),
    ).toThrow('CLOUDFLARE_WORKERS_SUBDOMAIN');
  });

  it('treats an unset GitHub Actions variable as absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-readiness-'));
    expect(
      resolveCloudflareWorkersDevSubdomain(root, { CLOUDFLARE_WORKERS_SUBDOMAIN: '' }),
    ).toBeUndefined();
  });

  it('caches a Wrangler-reported subdomain and preserves unrelated state', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-readiness-'));
    expect(
      rememberCloudflareWorkersDevSubdomain(
        root,
        'https://void-ready-abc-app.developer-platform-experience.workers.dev',
      ),
    ).toBe(true);
    expect(resolveCloudflareWorkersDevSubdomain(root, {})).toBe('developer-platform-experience');
    expect(JSON.parse(readFileSync(join(root, '.void', 'cloudflare.json'), 'utf-8'))).toEqual({
      workersDevSubdomain: 'developer-platform-experience',
    });
  });

  it('ignores URLs outside workers.dev', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-readiness-'));
    expect(rememberCloudflareWorkersDevSubdomain(root, 'https://example.com')).toBe(false);
    expect(resolveCloudflareWorkersDevSubdomain(root, {})).toBeUndefined();
  });
});
