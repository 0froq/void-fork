import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import { releasePolicy } from '../../../../.github/scripts/release-policy.ts';

describe('public package release policy', () => {
  it.each([
    ['0.11.0', 'latest'],
    ['0.11.0-beta.1', 'beta'],
    ['0.11.0-rc.2', 'rc'],
    ['0.11.0-1', 'next'],
    ['0.11.0-latest.1', 'next'],
  ])('publishes %s only to %s', (version, npmTag) => {
    expect(
      releasePolicy(`v${version}`, [
        { name: 'void', version },
        { name: '@void/platform', version },
      ]),
    ).toEqual({ version, npmTag });
  });

  it.each(['v0.1.0', 'v3.0.1'])('rejects the unavailable version %s', (tag) => {
    expect(() => releasePolicy(tag, [{ name: 'void', version: tag.slice(1) }])).toThrow(
      'cannot be reused',
    );
  });

  it.each(['latest', 'v01.2.3', 'v1.2.3-beta.01', 'v1.2.3\nother=tag', 'v1.2.3\n', 'v1.2.3+build'])(
    'rejects malformed release tag %s',
    (tag) => {
      expect(() => releasePolicy(tag, [])).toThrow('exact semantic version');
    },
  );

  it('rejects mismatched CLI, scaffolder, adapter, or runtime versions', () => {
    expect(() =>
      releasePolicy('v0.11.0-beta.1', [
        { name: 'void', version: '0.11.0-beta.1' },
        { name: 'create-void', version: '0.10.14' },
      ]),
    ).toThrow('create-void@0.10.14 does not match');
  });
});

describe('trusted publishing workflow', () => {
  const workflow = readFileSync(
    new URL('../../../../.github/workflows/publish.yml', import.meta.url),
    'utf8',
  );
  const publishJob = workflow.split('\n  publish:\n')[1]!;

  it('grants OIDC permission to the GitHub-hosted release job', () => {
    expect(publishJob).toBeDefined();
    expect(publishJob).toContain('    runs-on: ubuntu-latest\n');
    expect(publishJob).toContain('    environment: Release\n');
    expect(publishJob).toMatch(/ {4}permissions:\n(?: {6}[^\n]+\n)* {6}id-token: write\n/);
  });

  it('does not require a stored token or use whoami to validate OIDC', () => {
    expect(publishJob).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|npm whoami/);
    expect(publishJob).toContain('npm install -g npm@11');
    expect(publishJob).toContain(
      'vp pm publish -r --access public --tag "$RELEASE_NPM_TAG" --no-git-checks',
    );
  });

  it('keeps CI gates and validated stable or prerelease channel selection', () => {
    expect(publishJob).toContain('    needs: [ci, platform-ci, prepublish-test]\n');
    expect(publishJob).toContain('node .github/scripts/release-policy.ts');
    expect(publishJob).toContain('RELEASE_NPM_TAG: ${{ steps.release.outputs.npm-tag }}');
  });
});
