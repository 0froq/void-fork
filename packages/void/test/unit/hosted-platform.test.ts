import { readFileSync } from 'node:fs';
import { parsePlatformDeploymentManifest } from '@void/platform';
import { join } from 'pathslash';
import { describe, expect, it } from 'vite-plus/test';
import { VOID_CLOUD_PLATFORM } from '../../src/cli/hosted-platform.ts';

describe('Void Cloud compatibility manifest', () => {
  it('matches the public legacy endpoint without containing account secrets or ids', () => {
    const path = join(process.cwd(), 'platform', 'deployments', 'void-cloud.json');
    const raw = readFileSync(path, 'utf8');
    const manifest = parsePlatformDeploymentManifest(JSON.parse(raw) as unknown);
    expect(manifest.controlPlane.apiHostname).toBe(new URL(VOID_CLOUD_PLATFORM.apiUrl).hostname);
    expect(manifest.application.baseDomain).toBe(VOID_CLOUD_PLATFORM.applicationDomain);
    expect(manifest.displayName).toBe(VOID_CLOUD_PLATFORM.displayName);
    expect(raw).not.toMatch(/account[_-]?id|zone[_-]?id|api[_-]?token|secret/i);
  });
});
