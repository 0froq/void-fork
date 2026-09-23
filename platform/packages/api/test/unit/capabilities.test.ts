import { describe, expect, it } from 'vite-plus/test';
import adminPlatform from '../../src/admin/routes/platform.tsx';
import { getPlatformCapabilities } from '../../src/capabilities.ts';

describe('platform capabilities', () => {
  it('enables managed Sandbox when hosted configuration is absent', () => {
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

  it('honors the installed platform Sandbox capability', () => {
    expect(
      getPlatformCapabilities({
        PLATFORM_CAPABILITIES: JSON.stringify({
          ai: true,
          customDomains: true,
          email: true,
          githubActions: true,
          githubOAuth: true,
          googleOAuth: true,
          managedBuilds: true,
          sandbox: true,
        }),
      }).sandbox,
    ).toBe(true);
  });

  it('rejects incomplete capability configuration', () => {
    expect(() => getPlatformCapabilities({ PLATFORM_CAPABILITIES: '{"ai":true}' })).toThrow(
      'customDomains',
    );
  });

  it('blocks hosted Worker rollback operations on self-hosted installations', async () => {
    const response = await adminPlatform.request('/', {}, {
      PLATFORM_INSTALLATION_ID: 'company-a1b2c3d4',
    } as never);
    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({
      error: 'platform capability unavailable',
      capability: 'hosted-platform-operations',
      message: 'Manage this self-hosted Void platform with `void platform upgrade`.',
    });
  });

  it('gives browser users self-hosted upgrade guidance and a way back', async () => {
    const response = await adminPlatform.request('/', { headers: { Accept: 'text/html' } }, {
      PLATFORM_INSTALLATION_ID: 'company-private-installation',
    } as never);
    expect(response.status).toBe(501);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('<code>void platform upgrade</code>');
    expect(html).toContain('href="/admin/"');
    expect(html).not.toContain('company-private-installation');
  });
});
