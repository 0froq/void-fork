import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { getApiUrl, getSiteDomain } from '../../src/cli/auth.ts';
import { savePlatformConnection } from '../../src/cli/platform-registry.ts';
import {
  attachSelectedPlatform,
  isVoidInternalStaging,
  readDeploymentPlatform,
  readProjectConfig,
  writeDeploymentPlatform,
  writeProjectConfig,
} from '../../src/cli/project.ts';

const roots: Array<string> = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-project-config-'));
  roots.push(root);
  return root;
}

function writeProjectJson(root: string, value: unknown): void {
  const voidDir = join(root, '.void');
  mkdirSync(voidDir, { recursive: true });
  writeFileSync(join(voidDir, 'project.json'), JSON.stringify(value, null, 2) + '\n');
}

describe('project config', () => {
  afterEach(() => {
    delete process.env.VOID_API_URL;
    delete process.env.VOID_PLATFORM_REGISTRY_DIR;
    while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  it('does not treat an internal staging-only file as a linked project', () => {
    const root = makeRoot();
    writeProjectJson(root, { voidInternalStaging: true });

    expect(readProjectConfig(root)).toBeNull();
    expect(isVoidInternalStaging(root)).toBe(true);
    expect(readDeploymentPlatform(root)).toBeNull();
  });

  it('infers Void for legacy linked project files', () => {
    const root = makeRoot();
    writeProjectJson(root, { projectId: 'proj_123', slug: 'demo' });

    expect(readDeploymentPlatform(root)).toBe('void');
    expect(getApiUrl(root)).toBe('https://api.void.cloud');
  });

  it('keeps legacy Void Cloud projects pinned when another platform is active', () => {
    const root = makeRoot();
    const registry = makeRoot();
    process.env.VOID_PLATFORM_REGISTRY_DIR = registry;
    writeProjectJson(root, { projectId: 'proj_123', slug: 'demo' });
    savePlatformConnection({
      accountId: null,
      apiUrl: 'https://platform.example.test',
      applicationDomain: 'apps.example.test',
      displayName: 'Example',
      installationId: null,
      kind: 'connected',
    });

    expect(getApiUrl(root)).toBe('https://api.void.cloud');
    expect(getSiteDomain(root)).toBe('void.app');
  });

  it('stores a platform without requiring a Void project link', () => {
    const root = makeRoot();

    writeDeploymentPlatform(root, 'cloudflare');

    expect(readDeploymentPlatform(root)).toBe('cloudflare');
    expect(readProjectConfig(root)).toBeNull();
    expect(JSON.parse(readFileSync(join(root, '.void', 'project.json'), 'utf-8'))).toEqual({
      platform: 'cloudflare',
    });
  });

  it('preserves an existing Void project link when changing platforms', () => {
    const root = makeRoot();
    writeProjectJson(root, {
      projectId: 'proj_123',
      slug: 'demo',
      voidInternalStaging: true,
    });

    writeDeploymentPlatform(root, 'none');

    expect(readDeploymentPlatform(root)).toBe('none');
    expect(readProjectConfig(root)).toEqual({
      projectId: 'proj_123',
      slug: 'demo',
      voidInternalStaging: true,
    });
  });

  it('preserves the internal staging flag when linking a project', () => {
    const root = makeRoot();
    writeProjectJson(root, { voidInternalStaging: true });

    writeProjectConfig(root, { projectId: 'proj_123', slug: 'demo' });

    expect(readProjectConfig(root)).toEqual({
      projectId: 'proj_123',
      slug: 'demo',
      voidInternalStaging: true,
    });
    expect(JSON.parse(readFileSync(join(root, '.void', 'project.json'), 'utf-8'))).toEqual({
      platform: 'void',
      projectId: 'proj_123',
      slug: 'demo',
      voidInternalStaging: true,
    });
  });

  it('stores the linked platform origin and application domain', () => {
    const root = makeRoot();
    writeProjectConfig(root, {
      applicationDomain: 'Apps.Example.com.',
      platformUrl: 'https://platform.example.com/',
      projectId: 'proj_123',
      slug: 'demo',
    });

    expect(readProjectConfig(root)).toEqual({
      applicationDomain: 'apps.example.com',
      platformUrl: 'https://platform.example.com',
      projectId: 'proj_123',
      slug: 'demo',
    });
  });

  it('uses the staging API from the internal project flag unless explicitly overridden', () => {
    const root = makeRoot();
    writeProjectJson(root, { voidInternalStaging: true });

    expect(getApiUrl(root)).toBe('https://api.staging.void.cloud');

    process.env.VOID_API_URL = 'https://api.example.test';
    expect(getApiUrl(root)).toBe('https://api.example.test');
  });

  it('uses an active platform connection but keeps internal staging isolated', () => {
    const root = makeRoot();
    const registry = makeRoot();
    process.env.VOID_PLATFORM_REGISTRY_DIR = registry;
    savePlatformConnection({
      accountId: null,
      apiUrl: 'https://platform.example.test',
      applicationDomain: 'apps.example.test',
      displayName: 'Example',
      installationId: null,
      kind: 'connected',
    });
    expect(getApiUrl(root)).toBe('https://platform.example.test');

    writeProjectJson(root, { voidInternalStaging: true });
    expect(getApiUrl(root)).toBe('https://api.staging.void.cloud');
  });

  it('requires a selected platform before creating a new project link', () => {
    const root = makeRoot();
    process.env.VOID_PLATFORM_REGISTRY_DIR = makeRoot();
    expect(() => attachSelectedPlatform(root, { projectId: 'proj_new', slug: 'new-app' })).toThrow(
      'No Void platform selected',
    );
  });

  it('attaches the selected platform identity to a new project link', () => {
    const root = makeRoot();
    const registry = makeRoot();
    process.env.VOID_PLATFORM_REGISTRY_DIR = registry;
    savePlatformConnection({
      accountId: null,
      apiUrl: 'https://platform.example.test',
      applicationDomain: 'apps.example.test',
      displayName: 'Example',
      installationId: null,
      kind: 'connected',
    });
    expect(attachSelectedPlatform(root, { projectId: 'proj_new', slug: 'new-app' })).toEqual({
      applicationDomain: 'apps.example.test',
      platformUrl: 'https://platform.example.test',
      projectId: 'proj_new',
      slug: 'new-app',
    });
  });
});
