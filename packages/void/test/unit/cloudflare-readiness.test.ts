import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  rememberCloudflareWorkersDevSubdomain,
  resolveCloudflareReadinessAccessOrigin,
  resolveCloudflareWorkersDevSubdomain,
  withRecordedReadinessAccessOrigin,
} from '../../src/cli/cloudflare-readiness.ts';

const roots: Array<string> = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-readiness-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Cloudflare readiness state', () => {
  it('prefers and normalizes the environment override', () => {
    const root = tempRoot();
    expect(
      resolveCloudflareWorkersDevSubdomain(root, 'account-a', {
        CLOUDFLARE_WORKERS_SUBDOMAIN: 'Developer-Platform-Experience.workers.dev',
      }),
    ).toBe('developer-platform-experience');
  });

  it('rejects an invalid environment override', () => {
    const root = tempRoot();
    expect(() =>
      resolveCloudflareWorkersDevSubdomain(root, 'account-a', {
        CLOUDFLARE_WORKERS_SUBDOMAIN: 'https://example.com/path',
      }),
    ).toThrow('CLOUDFLARE_WORKERS_SUBDOMAIN');
  });

  it('treats an unset GitHub Actions variable as absent', () => {
    const root = tempRoot();
    expect(
      resolveCloudflareWorkersDevSubdomain(root, 'account-a', {
        CLOUDFLARE_WORKERS_SUBDOMAIN: '',
      }),
    ).toBeUndefined();
  });

  it('caches a Wrangler-reported subdomain and preserves unrelated state', () => {
    const root = tempRoot();
    expect(
      rememberCloudflareWorkersDevSubdomain(
        root,
        'account-a',
        'https://void-ready-abc-app.developer-platform-experience.workers.dev',
      ),
    ).toBe(true);
    expect(resolveCloudflareWorkersDevSubdomain(root, 'account-a', {})).toBe(
      'developer-platform-experience',
    );
    expect(resolveCloudflareWorkersDevSubdomain(root, 'account-b', {})).toBeUndefined();
    expect(JSON.parse(readFileSync(join(root, '.void', 'cloudflare.json'), 'utf-8'))).toEqual({
      workersDevSubdomains: { 'account-a': 'developer-platform-experience' },
    });
  });

  it('keeps cached subdomains isolated when a project switches accounts', () => {
    const root = tempRoot();
    rememberCloudflareWorkersDevSubdomain(root, 'account-a', 'https://app.first-team.workers.dev');
    rememberCloudflareWorkersDevSubdomain(root, 'account-b', 'https://app.second-team.workers.dev');

    expect(resolveCloudflareWorkersDevSubdomain(root, 'account-a', {})).toBe('first-team');
    expect(resolveCloudflareWorkersDevSubdomain(root, 'account-b', {})).toBe('second-team');
  });

  it('ignores URLs outside workers.dev', () => {
    const root = tempRoot();
    expect(rememberCloudflareWorkersDevSubdomain(root, 'account-a', 'https://example.com')).toBe(
      false,
    );
    expect(resolveCloudflareWorkersDevSubdomain(root, 'account-a', {})).toBeUndefined();
  });
});

describe('Cloudflare readiness Access origin', () => {
  it('normalizes the opted-in origin', () => {
    expect(
      resolveCloudflareReadinessAccessOrigin({
        CF_ACCESS_READINESS_ORIGIN: ' https://Dashboard.Internal.Example.com/ ',
      }),
    ).toBe('https://dashboard.internal.example.com');
  });

  it.each([
    'http://dashboard.example.com',
    'https://dashboard.example.com/__void/ready',
    'https://dashboard.example.com/?token=1',
    'https://dashboard.example.com/#ready',
    'https://user:pass@dashboard.example.com',
    'https://*.internal.example.com',
    'dashboard.example.com',
  ])('rejects %s', (value) => {
    expect(() =>
      resolveCloudflareReadinessAccessOrigin({ CF_ACCESS_READINESS_ORIGIN: value }),
    ).toThrow('CF_ACCESS_READINESS_ORIGIN');
  });

  it('treats an unset or empty GitHub Actions variable as absent', () => {
    expect(resolveCloudflareReadinessAccessOrigin({})).toBeUndefined();
    expect(
      resolveCloudflareReadinessAccessOrigin({ CF_ACCESS_READINESS_ORIGIN: '' }),
    ).toBeUndefined();
    expect(
      resolveCloudflareReadinessAccessOrigin({ CF_ACCESS_READINESS_ORIGIN: '  ' }),
    ).toBeUndefined();
  });

  it('records the operator value once and keeps it after the environment changes', () => {
    const later = { CF_ACCESS_READINESS_ORIGIN: 'https://collector.example.com' };
    expect(withRecordedReadinessAccessOrigin({}, {})).toEqual({ readinessAccessOrigin: null });
    expect(
      withRecordedReadinessAccessOrigin(
        {},
        { CF_ACCESS_READINESS_ORIGIN: 'https://app.example.com' },
      ),
    ).toEqual({ readinessAccessOrigin: 'https://app.example.com' });
    expect(withRecordedReadinessAccessOrigin({ readinessAccessOrigin: null }, later)).toEqual({
      readinessAccessOrigin: null,
    });
    expect(
      withRecordedReadinessAccessOrigin(
        { readinessAccessOrigin: 'https://app.example.com' },
        later,
      ),
    ).toEqual({ readinessAccessOrigin: 'https://app.example.com' });
  });
});
