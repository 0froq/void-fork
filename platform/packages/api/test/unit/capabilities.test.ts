import { describe, expect, it } from 'vite-plus/test';
import { getPlatformCapabilities } from '../../src/capabilities.ts';

describe('platform capabilities', () => {
  it('keeps all hosted Void Cloud capabilities enabled when configuration is absent', () => {
    expect(getPlatformCapabilities({})).toEqual({
      ai: true,
      customDomains: true,
      email: true,
      githubActions: true,
      githubOAuth: true,
      googleOAuth: true,
      managedBuilds: true,
      sandbox: true,
    });
  });

  it('rejects incomplete capability configuration', () => {
    expect(() => getPlatformCapabilities({ PLATFORM_CAPABILITIES: '{"ai":true}' })).toThrow(
      'customDomains',
    );
  });
});
