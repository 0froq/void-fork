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
  proxyUrl: 'https://proxy.example.com',
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

  it('fills the hosted proxy for older Void Cloud discovery documents', async () => {
    const legacyHosted = { ...document, apiUrl: 'https://api.void.cloud' } as Record<
      string,
      unknown
    >;
    delete legacyHosted.proxyUrl;
    const response = new Response(JSON.stringify(legacyHosted));
    Object.defineProperty(response, 'url', {
      value: 'https://api.void.cloud/.well-known/void-platform',
    });

    await expect(
      discoverPlatform('https://api.void.cloud', async () => response),
    ).resolves.toMatchObject({ proxyUrl: 'https://proxy.void.cloud' });
  });

  it('rejects custom discovery documents without a proxy origin', async () => {
    const incomplete = { ...document } as Record<string, unknown>;
    delete incomplete.proxyUrl;
    const response = new Response(JSON.stringify(incomplete));
    Object.defineProperty(response, 'url', {
      value: 'https://api.example.com/.well-known/void-platform',
    });

    await expect(discoverPlatform('https://api.example.com', async () => response)).rejects.toThrow(
      'proxyUrl',
    );
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
