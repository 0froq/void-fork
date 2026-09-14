import { describe, expect, it } from 'vite-plus/test';
import { discoverPlatform } from '../../src/cli/platform-cmd.ts';

const document = {
  apiUrl: 'https://api.example.com',
  applicationDomain: 'apps.example.com',
  authenticationProviders: ['github'],
  capabilities: {
    ai: true,
    customDomains: false,
    email: false,
    githubActions: false,
    githubOAuth: true,
    googleOAuth: false,
    managedBuilds: false,
    sandbox: false,
  },
  displayName: 'Example',
  installationId: 'example-a1b2c3d4',
  platformVersion: '1.0.0',
  schemaVersion: 1,
};

describe('platform discovery', () => {
  it('accepts a valid document from its declared origin', async () => {
    const response = new Response(JSON.stringify(document));
    Object.defineProperty(response, 'url', {
      value: 'https://api.example.com/.well-known/void-platform',
    });
    await expect(
      discoverPlatform('https://api.example.com', async () => response),
    ).resolves.toMatchObject({ displayName: 'Example' });
  });

  it('rejects discovery documents that claim a different origin', async () => {
    const response = new Response(JSON.stringify(document));
    Object.defineProperty(response, 'url', {
      value: 'https://evil.example/.well-known/void-platform',
    });
    await expect(discoverPlatform('https://api.example.com', async () => response)).rejects.toThrow(
      'origin mismatch',
    );
  });
});
