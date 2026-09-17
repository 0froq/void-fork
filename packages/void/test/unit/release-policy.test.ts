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

  it.each([
    ['v0.21.0+retry.1', '0.21.0', 'latest'],
    ['v0.21.0+retry.27', '0.21.0', 'latest'],
    ['v0.21.0-beta.1+retry.2', '0.21.0-beta.1', 'beta'],
    ['v0.21.0-rc.2+retry.1', '0.21.0-rc.2', 'rc'],
    ['v0.21.0-1+retry.1', '0.21.0-1', 'next'],
    ['v0.21.0-latest.1+retry.1', '0.21.0-latest.1', 'next'],
  ])('treats %s as an attempt to publish %s to %s', (tag, version, npmTag) => {
    expect(
      releasePolicy(tag, [
        { name: 'void', version },
        { name: '@void/platform', version },
      ]),
    ).toEqual({ version, npmTag });
  });

  it.each([
    'v0.21.0+retry',
    'v0.21.0+retry.',
    'v0.21.0+retry.0',
    'v0.21.0+retry.01',
    'v0.21.0+retry.-1',
    'v0.21.0+retry.1.extra',
    'v0.21.0+retry.1+retry.2',
    'v0.21.0+Retry.1',
    'v0.21.0+build.1',
    'v0.21.0-beta.01+retry.1',
    'v0.21.0+retry.1\n',
    'v0.21.0+retry.1\nversion=other',
  ])('rejects malformed or unrecognized retry metadata: %s', (tag) => {
    expect(() => releasePolicy(tag, [])).toThrow('optionally ending in +retry.N');
  });

  it('keeps numeric prereleases distinct from stable release retries', () => {
    expect(() => releasePolicy('v0.21.0-1', [{ name: 'void', version: '0.21.0' }])).toThrow(
      'Retry tags use +retry.N',
    );
  });

  it.each(['0.21.1', '0.21.0+retry.1'])(
    'requires retry tags to match the plain package version (%s)',
    (version) => {
      expect(() => releasePolicy('v0.21.0+retry.1', [{ name: 'void', version }])).toThrow(
        'does not match release',
      );
    },
  );

  it('checks every package on a retry, not just the CLI', () => {
    expect(() =>
      releasePolicy('v0.21.0+retry.1', [
        { name: 'void', version: '0.21.0' },
        { name: '@void/platform', version: '0.20.0' },
      ]),
    ).toThrow('@void/platform@0.20.0 does not match');
  });

  it.each(['v0.1.0', 'v3.0.1'])('rejects the unavailable version %s', (tag) => {
    expect(() => releasePolicy(tag, [{ name: 'void', version: tag.slice(1) }])).toThrow(
      'cannot be reused',
    );
  });

  it.each(['v0.1.0+retry.1', 'v3.0.1+retry.2'])(
    'rejects retrying an unavailable version: %s',
    (tag) => {
      expect(() =>
        releasePolicy(tag, [{ name: 'void', version: tag.slice(1).split('+')[0]! }]),
      ).toThrow('cannot be reused');
    },
  );

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
  function job(name: string): string {
    const parts = workflow.split(`\n  ${name}:\n`);
    expect(parts).toHaveLength(2);
    return parts[1]!.split(/\n {2}[\w-]+:\n/)[0]!;
  }
  const publishJob = job('publish');

  it('rejects invalid tags before installing dependencies or running CI', () => {
    const validation = job('validate-release');
    expect(validation).toContain('node .github/scripts/release-policy.ts');
    expect(validation).toContain('run-install: false');
    expect(validation).toContain('cache: false');
    expect(validation).not.toContain('id-token: write');
    for (const name of ['ci', 'platform-ci', 'prepublish-test']) {
      expect(job(name)).toContain('    needs: validate-release\n');
    }
  });

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
    expect(publishJob).not.toContain('--force');
  });

  it('keeps CI gates and validated stable or prerelease channel selection', () => {
    expect(publishJob).toContain('    needs: [ci, platform-ci, prepublish-test]\n');
    expect(publishJob).toContain('node .github/scripts/release-policy.ts');
    expect(publishJob).toContain('RELEASE_NPM_TAG: ${{ steps.release.outputs.npm-tag }}');
  });
});
