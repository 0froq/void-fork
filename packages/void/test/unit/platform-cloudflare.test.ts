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

  it('exhausts paginated collision checks for platform resource names', async () => {
    const calls: Array<string> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input) => {
        const url = new URL(String(input));
        calls.push(`${url.pathname}?${url.searchParams}`);
        const page = Number(url.searchParams.get('page') ?? '1');
        if (url.pathname.endsWith('/ai-gateway/gateways')) {
          return Response.json({
            success: true,
            result:
              page === 1
                ? Array.from({ length: 50 }, (_, index) => ({ id: `gateway-${index}` }))
                : [{ id: 'gateway-50' }],
          });
        }
        return Response.json({
          success: true,
          result:
            page === 1
              ? Array.from({ length: 50 }, (_, index) => ({
                  id: `hyperdrive-${index}`,
                  name: `hyperdrive-${index}`,
                }))
              : [{ id: 'hyperdrive-50', name: 'hyperdrive-50' }],
        });
      },
    });

    await expect(client.listAiGateways('account')).resolves.toHaveLength(51);
    await expect(client.listHyperdriveConfigs('account')).resolves.toHaveLength(51);
    expect(calls.filter((call) => call.includes('ai-gateway'))).toHaveLength(2);
    expect(calls.filter((call) => call.includes('hyperdrive'))).toHaveLength(2);
  });

  it('paginates R2 buckets with a stable start-after cursor', async () => {
    const cursors: Array<string> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input) => {
        const url = new URL(String(input));
        const cursor = url.searchParams.get('start_after') ?? '';
        cursors.push(cursor);
        const buckets = cursor
          ? [{ name: 'bucket-1000' }]
          : Array.from({ length: 1000 }, (_, index) => ({
              name: `bucket-${String(index).padStart(4, '0')}`,
            }));
        return Response.json({ success: true, result: { buckets } });
      },
    });

    await expect(client.listR2Buckets('account')).resolves.toHaveLength(1001);
    expect(cursors).toEqual(['', 'bucket-0999']);
  });

  it('writes and reads reserved R2 ownership markers', async () => {
    const requests: Array<{ body: string; method: string; pathname: string }> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        requests.push({
          body: String(init?.body ?? ''),
          method: init?.method ?? 'GET',
          pathname: url.pathname,
        });
        return init?.method === 'PUT'
          ? new Response(null, { status: 200 })
          : new Response('marker');
      },
    });

    await client.putR2Object('account', 'bucket/name', 'reserved/key', 'marker');
    await expect(client.getR2Object('account', 'bucket/name', 'reserved/key')).resolves.toBe(
      'marker',
    );
    expect(requests).toEqual([
      {
        body: 'marker',
        method: 'PUT',
        pathname: '/client/v4/accounts/account/r2/buckets/bucket%2Fname/objects/reserved%2Fkey',
      },
      {
        body: '',
        method: 'GET',
        pathname: '/client/v4/accounts/account/r2/buckets/bucket%2Fname/objects/reserved%2Fkey',
      },
    ]);
  });

  it('reads only plain-text Worker ownership bindings', async () => {
    const client = new PlatformCloudflareClient('token', {
      fetcher: async () =>
        Response.json({
          success: true,
          result: {
            bindings: [
              { name: 'PLATFORM_OWNERSHIP_MARKER', text: 'owned', type: 'plain_text' },
              { name: 'SECRET', type: 'secret_text' },
            ],
          },
        }),
    });
    await expect(client.getWorkerPlainTextBindings('account', 'worker')).resolves.toEqual({
      PLATFORM_OWNERSHIP_MARKER: 'owned',
    });
  });

  it('empties every paginated R2 object before bucket deletion', async () => {
    const deleted: Array<ReadonlyArray<string>> = [];
    const cursors: Array<string> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        if (init?.method === 'DELETE') {
          const keys = JSON.parse(String(init.body)) as Array<string>;
          deleted.push(keys);
          return Response.json({
            success: true,
            result: keys.map((key) => ({ key })),
          });
        }
        const cursor = url.searchParams.get('cursor') ?? '';
        cursors.push(cursor);
        return Response.json(
          cursor
            ? { success: true, result: [{ key: 'nested/c.txt' }] }
            : {
                success: true,
                result: [
                  { key: 'a.txt' },
                  { key: '__void/platform/ownership/v1' },
                  { key: 'b.txt' },
                ],
                result_info: { cursor: 'next-page' },
              },
        );
      },
    });

    await client.emptyR2Bucket('account', 'void-assets', new Set(['__void/platform/ownership/v1']));
    expect(cursors).toEqual(['', 'next-page']);
    expect(deleted).toEqual([['a.txt', 'b.txt'], ['nested/c.txt']]);
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

  it('enables and disables the workers.dev endpoint for one Worker', async () => {
    const bodies: Array<unknown> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ success: true, result: null });
      },
    });
    await client.setWorkerSubdomain('account', 'void-company-api', false);
    await client.setWorkerSubdomain('account', 'void-company-api', true);
    expect(bodies).toEqual([
      { enabled: false, previews_enabled: false },
      { enabled: true, previews_enabled: true },
    ]);
  });

  it('removes Worker routes and custom domains through the account domains API', async () => {
    const requests: Array<{ method: string; pathname: string; service: string | null }> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        requests.push({
          method: init?.method ?? 'GET',
          pathname: url.pathname,
          service: url.searchParams.get('service'),
        });
        if (url.pathname.endsWith('/workers/routes')) {
          return Response.json({
            success: true,
            result: [
              { id: 'route-api', script: 'void-team-api' },
              { id: 'route-other', script: 'unrelated' },
            ],
          });
        }
        if (url.pathname.endsWith('/workers/domains')) {
          const service = url.searchParams.get('service');
          return Response.json({
            success: true,
            result: [{ id: `domain-${service}`, service }],
          });
        }
        return Response.json({ success: true, result: null });
      },
    });

    await client.removeRoutes('account', 'zone', new Set(['void-team-api', 'void-team-proxy']));

    expect(requests).toEqual([
      {
        method: 'GET',
        pathname: '/client/v4/zones/zone/workers/routes',
        service: null,
      },
      {
        method: 'DELETE',
        pathname: '/client/v4/zones/zone/workers/routes/route-api',
        service: null,
      },
      {
        method: 'GET',
        pathname: '/client/v4/accounts/account/workers/domains',
        service: 'void-team-api',
      },
      {
        method: 'DELETE',
        pathname: '/client/v4/accounts/account/workers/domains/domain-void-team-api',
        service: null,
      },
      {
        method: 'GET',
        pathname: '/client/v4/accounts/account/workers/domains',
        service: 'void-team-proxy',
      },
      {
        method: 'DELETE',
        pathname: '/client/v4/accounts/account/workers/domains/domain-void-team-proxy',
        service: null,
      },
    ]);
  });

  it('inventories Worker custom domains before installer deployment', async () => {
    const client = new PlatformCloudflareClient('token', {
      fetcher: async () =>
        Response.json({
          success: true,
          result: [
            { hostname: 'api.platform.example.com', id: 'domain-id', service: 'existing-worker' },
          ],
        }),
    });
    await expect(client.listWorkerDomains('account')).resolves.toEqual([
      {
        hostname: 'api.platform.example.com',
        id: 'domain-id',
        service: 'existing-worker',
      },
    ]);
  });
});
