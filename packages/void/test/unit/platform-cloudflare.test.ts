import { describe, expect, it } from 'vite-plus/test';
import {
  parsePostgresConnectionString,
  PlatformCloudflareClient,
} from '../../src/cli/platform-cloudflare.ts';

describe('platform Cloudflare client', () => {
  it('parses PostgreSQL credentials without exposing them', () => {
    expect(
      parsePostgresConnectionString('postgres://user:p%40ss@db.example.com:5433/void'),
    ).toEqual({
      database: 'void',
      host: 'db.example.com',
      password: 'p@ss',
      port: 5433,
      user: 'user',
    });
    expect(() => parsePostgresConnectionString('mysql://user:secret@db.example.com/db')).toThrow(
      'postgres://',
    );
  });

  it('never includes the API token in errors', async () => {
    const token = 'super-secret-token';
    const client = new PlatformCloudflareClient(token, {
      fetcher: async () => new Response('not json', { status: 500 }),
    });
    let message = '';
    try {
      await client.verifyToken();
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain(token);
    expect(message).toContain('non-JSON');
  });

  it('paginates namespace discovery without a title filter', async () => {
    const pages: Array<string> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input) => {
        const url = new URL(String(input));
        pages.push(url.searchParams.get('page') ?? '');
        const page = url.searchParams.get('page');
        const result =
          page === '1'
            ? Array.from({ length: 100 }, (_, index) => ({
                id: `id-${index}`,
                title: `namespace-${index}`,
              }))
            : [{ id: 'id-100', title: 'namespace-100' }];
        return Response.json({ success: true, result });
      },
    });
    await expect(client.listKvNamespaces('account')).resolves.toHaveLength(101);
    expect(pages).toEqual(['1', '2']);
  });

  it('uses the documented AI Gateway lifecycle endpoints and creation shape', async () => {
    const requests: Array<{ body: unknown; method: string; pathname: string }> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        requests.push({
          body: init?.body ? JSON.parse(String(init.body)) : null,
          method: init?.method ?? 'GET',
          pathname: url.pathname,
        });
        const result =
          init?.method === 'POST'
            ? { id: 'void-team' }
            : init?.method === 'DELETE'
              ? null
              : [{ id: 'void-team' }];
        return Response.json({ success: true, result });
      },
    });

    await expect(client.listAiGateways('account')).resolves.toEqual([
      { id: 'void-team', name: 'void-team' },
    ]);
    await expect(client.createAiGateway('account', 'void-team')).resolves.toEqual({
      id: 'void-team',
      name: 'void-team',
    });
    await client.deleteResource('account', 'ai-gateway', 'void-team');

    expect(requests).toEqual([
      {
        body: null,
        method: 'GET',
        pathname: '/client/v4/accounts/account/ai-gateway/gateways',
      },
      {
        body: {
          cache_invalidate_on_update: false,
          cache_ttl: null,
          collect_logs: true,
          id: 'void-team',
          rate_limiting_interval: null,
          rate_limiting_limit: null,
        },
        method: 'POST',
        pathname: '/client/v4/accounts/account/ai-gateway/gateways',
      },
      {
        body: null,
        method: 'DELETE',
        pathname: '/client/v4/accounts/account/ai-gateway/gateways/void-team',
      },
    ]);
  });

  it('creates and deletes the proxied wildcard application DNS record in its zone', async () => {
    const requests: Array<{ body: unknown; method: string; pathname: string }> = [];
    const dns = {
      content: '100::',
      id: 'dns-id',
      name: '*.apps.example.com',
      proxied: true,
      type: 'AAAA',
    };
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        requests.push({
          body: init?.body ? JSON.parse(String(init.body)) : null,
          method: init?.method ?? 'GET',
          pathname: url.pathname,
        });
        return Response.json({
          success: true,
          result:
            init?.method === 'GET' || !init?.method ? [dns] : init.method === 'POST' ? dns : null,
        });
      },
    });

    await expect(client.listDnsRecords('zone-id', '*.apps.example.com')).resolves.toEqual([dns]);
    await expect(client.createDnsRecord('zone-id', '*.apps.example.com')).resolves.toEqual(dns);
    await client.deleteResource('account', 'dns-record', 'dns-id', 'zone-id');

    expect(requests).toEqual([
      { body: null, method: 'GET', pathname: '/client/v4/zones/zone-id/dns_records' },
      {
        body: {
          content: '100::',
          name: '*.apps.example.com',
          proxied: true,
          ttl: 1,
          type: 'AAAA',
        },
        method: 'POST',
        pathname: '/client/v4/zones/zone-id/dns_records',
      },
      {
        body: null,
        method: 'DELETE',
        pathname: '/client/v4/zones/zone-id/dns_records/dns-id',
      },
    ]);
  });
});
