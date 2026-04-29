import { describe, expect, it } from 'vitest';
import { buildRoutingJson, buildStaticRoutingJson } from '../../src/routing.ts';

describe('buildRoutingJson', () => {
  const base = {
    workerName: 'user-app',
    projectId: 'proj_1',
    userId: 'user_1',
    manifest: null,
    deploymentId: 'dep_1',
    dispatchLimits: null,
  };

  it('omits assetManifestId and assetConfig when not provided', () => {
    const parsed = JSON.parse(buildRoutingJson(base));
    expect(parsed.assetManifestId).toBeUndefined();
    expect(parsed.assetConfig).toBeUndefined();
  });

  it('emits assetManifestId when provided', () => {
    const parsed = JSON.parse(buildRoutingJson({ ...base, assetManifestId: 'dep_1' }));
    expect(parsed.assetManifestId).toBe('dep_1');
  });

  it('emits assetConfig when provided', () => {
    const parsed = JSON.parse(
      buildRoutingJson({
        ...base,
        assetManifestId: 'dep_1',
        assetConfig: { not_found_handling: 'none' },
      }),
    );
    expect(parsed.assetConfig).toEqual({ not_found_handling: 'none' });
  });

  it('keeps staticDeploymentId absent (WfP entries must not be misclassified)', () => {
    const parsed = JSON.parse(
      buildRoutingJson({
        ...base,
        assetManifestId: 'dep_1',
        assetConfig: { not_found_handling: 'none' },
      }),
    );
    expect(parsed.staticDeploymentId).toBeUndefined();
  });
});

describe('buildStaticRoutingJson', () => {
  it('still emits staticDeploymentId (unchanged behavior)', () => {
    const parsed = JSON.parse(
      buildStaticRoutingJson({
        projectId: 'proj_1',
        userId: 'user_1',
        deploymentId: 'dep_1',
        assetConfig: { not_found_handling: 'single-page-application' },
        manifest: null,
      }),
    );
    expect(parsed.staticDeploymentId).toBe('dep_1');
    expect(parsed.assetConfig).toEqual({ not_found_handling: 'single-page-application' });
    expect(parsed.assetManifestId).toBeUndefined();
  });
});
