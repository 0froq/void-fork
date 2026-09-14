import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index.ts';
import { setupEnv, teardownEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

describe('GET /.well-known/void-platform', () => {
  it('describes existing Void Cloud without exposing resource ids or credentials', async () => {
    const response = await app.fetch(
      new Request('https://api.void.cloud/.well-known/void-platform'),
      env,
    );
    expect(response.status).toBe(200);
    const document = await response.json<Record<string, unknown>>();
    expect(document).toMatchObject({
      apiUrl: 'https://api.void.cloud',
      applicationDomain: 'void.app',
      displayName: 'Void Cloud',
      schemaVersion: 1,
    });
    const serialized = JSON.stringify(document);
    expect(serialized).not.toMatch(/token|secret|accountId|zoneId|resource/i);
  });

  it('publishes a self-hosted installation identity and capability set', async () => {
    const selfHostedEnv = {
      ...env,
      PLATFORM_CAPABILITIES: JSON.stringify({
        ai: true,
        customDomains: false,
        email: false,
        githubActions: false,
        githubOAuth: true,
        googleOAuth: false,
        managedBuilds: false,
        sandbox: false,
      }),
      PLATFORM_DISPLAY_NAME: 'Developer Platform Experience',
      PLATFORM_INSTALLATION_ID: 'dpx-a1b2c3d4',
      PLATFORM_VERSION: '0.10.13',
      SITE_DOMAIN: 'apps.example.com',
    };
    const response = await app.fetch(
      new Request('https://platform.example.com/.well-known/void-platform'),
      selfHostedEnv,
    );
    expect(await response.json()).toMatchObject({
      apiUrl: 'https://platform.example.com',
      applicationDomain: 'apps.example.com',
      authenticationProviders: ['github'],
      displayName: 'Developer Platform Experience',
      installationId: 'dpx-a1b2c3d4',
      platformVersion: '0.10.13',
    });
  });
});
