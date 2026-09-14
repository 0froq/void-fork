import { afterEach, describe, expect, it } from 'vite-plus/test';
import { resolvePlatformInstallDatabaseUrl } from '../../src/cli/platform-lifecycle.ts';

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.VOID_PLATFORM_DATABASE_URL;
});

describe('platform lifecycle', () => {
  it('lets explicit database input replace an unverified install checkpoint', () => {
    const checkpoint = { databaseUrl: 'postgres://unreachable.example/void' };

    process.env.DATABASE_URL = 'postgres://corrected.example/void';
    expect(resolvePlatformInstallDatabaseUrl(checkpoint)).toBe('postgres://corrected.example/void');

    process.env.VOID_PLATFORM_DATABASE_URL = 'postgres://explicit.example/void';
    expect(resolvePlatformInstallDatabaseUrl(checkpoint)).toBe('postgres://explicit.example/void');
  });
});
