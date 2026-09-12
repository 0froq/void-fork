import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  activateCloudflareExistingVersion,
  changeCloudflareDomain,
  deleteCloudflareSecret,
  executeCloudflareD1Sql,
  applyCloudflareD1Migrations,
  listCloudflareDomains,
  listCloudflareSecrets,
  parseActiveVersionId,
  parseCloudflareDeployedVersionIds,
  parseCloudflareVersions,
  putCloudflareSecret,
  readCloudflareWorkerStatus,
  readCloudflareD1Migrations,
  resolveCloudflareD1Context,
  syncCloudflareSecrets,
  tailCloudflareWorker,
  type CloudflareOperationContext,
  type CloudflareOperationRunner,
} from '../../src/cli/cloudflare-operations.ts';
import { readWranglerCustomDomains, updateWranglerCustomDomain } from '../../src/cli/wrangler.ts';

const ok = (stdout = '') => ({ status: 0, stdout, stderr: '', signal: null, error: null });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function context(runWrangler: CloudflareOperationRunner): CloudflareOperationContext {
  return {
    accountId: 'account-1',
    apiBaseUrl: 'https://api.cloudflare.com/client/v4',
    configPath: '/app/wrangler.jsonc',
    workerName: 'my-worker',
    runWrangler,
  };
}

function project(config?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-operations-'));
  writeFileSync(
    join(root, 'wrangler.jsonc'),
    config ??
      '{\n  "name": "my-worker",\n  "account_id": "account-1",\n  "compatibility_date": "2026-02-24"\n}\n',
  );
  return root;
}

describe('Cloudflare operational parsing', () => {
  it('reads active traffic and Void migration metadata', () => {
    expect(
      parseActiveVersionId(
        JSON.stringify({
          versions: [
            { version_id: 'canary', percentage: 10 },
            { version_id: 'active', percentage: 100 },
          ],
        }),
      ),
    ).toBe('active');
    expect(
      parseActiveVersionId(
        JSON.stringify({
          versions: [
            { version_id: 'stable', percentage: 90 },
            { version_id: 'canary', percentage: 10 },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      parseCloudflareVersions(
        JSON.stringify([
          {
            id: 'version-1',
            metadata: { created_on: '2026-09-11T00:00:00.000Z' },
            annotations: {
              'workers/message': 'void:{"schema":1,"migrations":["0000_init.sql"]}',
            },
          },
        ]),
      ),
    ).toEqual([
      {
        id: 'version-1',
        createdAt: '2026-09-11T00:00:00.000Z',
        message: 'void:{"schema":1,"migrations":["0000_init.sql"]}',
        metadata: { schema: 1, migrations: ['0000_init.sql'] },
      },
    ]);
  });

  it('fails closed on malformed Wrangler JSON', () => {
    expect(() => parseCloudflareVersions('{}')).toThrow('unexpected response');
    expect(() => parseActiveVersionId('{')).toThrow('did not return valid JSON');
  });

  it('accepts only versions recorded in deployment history as rollback candidates', () => {
    expect(
      parseCloudflareDeployedVersionIds(
        JSON.stringify([
          { versions: [{ version_id: 'v1', percentage: 100 }] },
          {
            versions: [
              { version_id: 'v2', percentage: 100 },
              { version_id: 'failed-readiness', percentage: 0 },
            ],
          },
        ]),
      ),
    ).toEqual(['v1', 'v2']);
    expect(() => parseCloudflareDeployedVersionIds('[{"versions":[{}]}]')).toThrow('malformed');
    expect(() => parseCloudflareDeployedVersionIds('[{"versions":[{"version_id":"v3"}]}]')).toThrow(
      'malformed',
    );
  });
});

describe('Cloudflare secret operations', () => {
  it('lists only secret names and sorts them', async () => {
    const runner = vi
      .fn<CloudflareOperationRunner>()
      .mockReturnValue(
        ok(JSON.stringify([{ name: 'ZED', type: 'secret_text' }, { name: 'ALPHA' }])),
      );
    await expect(listCloudflareSecrets(context(runner))).resolves.toEqual(['ALPHA', 'ZED']);
    expect(runner).toHaveBeenCalledWith(
      [
        'secret',
        'list',
        '-c',
        '/app/wrangler.jsonc',
        '--env=',
        '--name',
        'my-worker',
        '--format',
        'json',
      ],
      { capture: true, input: undefined },
    );
  });

  it('streams put and bulk values over stdin, never argv', async () => {
    const runner = vi.fn<CloudflareOperationRunner>().mockReturnValue(ok());
    const ctx = context(runner);
    await putCloudflareSecret(ctx, 'API_KEY', 'super-secret');
    await syncCloudflareSecrets(ctx, [
      { name: 'ONE', value: 'first' },
      { name: 'TWO', value: 'second' },
    ]);
    const putCall = runner.mock.calls[0];
    expect(putCall[0]).not.toContain('super-secret');
    expect(putCall[1].input).toBe('super-secret');
    const bulkCall = runner.mock.calls[1];
    expect(bulkCall[0]).not.toContain('first');
    expect(JSON.parse(bulkCall[1].input!)).toEqual({ ONE: 'first', TWO: 'second' });
  });

  it('uses Wrangler delete only after the user invokes delete', async () => {
    const runner = vi.fn<CloudflareOperationRunner>().mockReturnValue(ok());
    await deleteCloudflareSecret(context(runner), 'OLD_KEY');
    expect(runner.mock.calls[0][0].slice(0, 3)).toEqual(['secret', 'delete', 'OLD_KEY']);
  });
});

describe('Cloudflare version operations', () => {
  it('reads deployment status and recent versions', async () => {
    const runner = vi.fn<CloudflareOperationRunner>((args) => {
      if (args[0] === 'deployments' && args[1] === 'status') {
        return ok(JSON.stringify({ versions: [{ version_id: 'v2', percentage: 100 }] }));
      }
      if (args[0] === 'deployments' && args[1] === 'list') {
        return ok(JSON.stringify([{ versions: [{ version_id: 'v1', percentage: 100 }] }]));
      }
      return ok(
        JSON.stringify([
          { id: 'v1', metadata: {}, annotations: {} },
          { id: 'v2', metadata: {}, annotations: {} },
        ]),
      );
    });
    const status = await readCloudflareWorkerStatus(context(runner));
    expect(status.activeVersionId).toBe('v2');
    expect(status.deployedVersionIds).toEqual(['v1', 'v2']);
    expect(status.versions.map((version) => version.id)).toEqual(['v1', 'v2']);
  });

  it('activates the selected version and restores its versioned triggers', async () => {
    const runner = vi.fn<CloudflareOperationRunner>().mockReturnValue(ok());
    await activateCloudflareExistingVersion(context(runner), {
      id: 'v1',
      createdAt: null,
      message: null,
      metadata: {
        schema: 2,
        migrations: ['0000_init.sql'],
        triggerConfig: {
          workers_dev: true,
          preview_urls: true,
          routes: [],
          crons: ['0 * * * *'],
          queueConsumers: [],
          workflows: [],
        },
      },
    });
    expect(runner.mock.calls[0][0]).toContain('v1@100');
    expect(runner.mock.calls[0][0]).toContain(
      'void:{"schema":2,"migrations":["0000_init.sql"],"triggerConfig":{"workers_dev":true,"preview_urls":true,"routes":[],"crons":["0 * * * *"],"queueConsumers":[],"workflows":[]}}',
    );
    expect(runner.mock.calls[1][0].slice(0, 2)).toEqual(['triggers', 'deploy']);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('restores the active version and triggers when rollback trigger sync fails', async () => {
    let triggerCalls = 0;
    const runner = vi.fn<CloudflareOperationRunner>((args) => {
      if (args[0] === 'triggers' && ++triggerCalls === 1) {
        return { ...ok(), status: 1, stderr: 'partial trigger failure' };
      }
      return ok();
    });
    const triggerConfig = {
      workers_dev: true,
      preview_urls: true,
      routes: [],
      crons: [],
      queueConsumers: [],
      workflows: [],
    };

    await expect(
      activateCloudflareExistingVersion(
        context(runner),
        {
          id: 'v1',
          createdAt: null,
          message: null,
          metadata: { schema: 2, migrations: [], triggerConfig },
        },
        {
          id: 'v2',
          createdAt: null,
          message: null,
          metadata: { schema: 2, migrations: [], triggerConfig },
        },
      ),
    ).rejects.toThrow(/traffic and triggers were restored to v2/);
    expect(runner.mock.calls.some(([args]) => args.includes('v2@100'))).toBe(true);
    expect(runner.mock.calls.filter(([args]) => args[0] === 'triggers')).toHaveLength(2);
  });

  it('maps search, version, and error filters to a live tail', async () => {
    const runner = vi.fn<CloudflareOperationRunner>().mockReturnValue(ok());
    await tailCloudflareWorker(context(runner), {
      filter: 'socket',
      versionId: 'v1',
      status: 'error',
    });
    expect(runner.mock.calls[0]).toEqual([
      [
        'tail',
        'my-worker',
        '-c',
        '/app/wrangler.jsonc',
        '--env=',
        '--format',
        'pretty',
        '--search',
        'socket',
        '--version-id',
        'v1',
        '--status',
        'error',
      ],
      { capture: false, input: undefined },
    ]);
  });
});

describe('Cloudflare D1 operations', () => {
  it('resolves the configured migration identity and executes remote SQL as JSON', async () => {
    const root = project(`{
  "name": "my-worker",
  "account_id": "account-1",
  "d1_databases": [{
    "binding": "DATA",
    "database_name": "my-data",
    "database_id": "11111111-2222-3333-4444-555555555555",
    "migrations_dir": "db/custom",
    "migrations_table": "custom_migrations"
  }]
}\n`);
    const runner = vi
      .fn<CloudflareOperationRunner>()
      .mockReturnValue(ok(JSON.stringify([{ success: true, results: [{ id: 1, name: 'Ada' }] }])));
    const ctx = resolveCloudflareD1Context(root, 'DATA', runner);
    expect(ctx).toMatchObject({
      binding: 'DATA',
      migrateToken: 'my-data',
      migrationsDir: 'db/custom',
      migrationsTable: 'custom_migrations',
    });
    await expect(executeCloudflareD1Sql(ctx, 'select * from users')).resolves.toEqual([
      { id: 1, name: 'Ada' },
    ]);
    expect(runner.mock.calls[0][0]).toContain('--remote');
    expect(runner.mock.calls[0][0]).toContain('--json');
  });

  it('reads applied migration names from a custom tracking table', async () => {
    const runner = vi
      .fn<CloudflareOperationRunner>()
      .mockReturnValue(
        ok(
          JSON.stringify([
            { success: true, results: [{ name: '0000_init.sql' }, { name: '0001_more.sql' }] },
          ]),
        ),
      );
    const ctx = {
      operation: context(runner),
      binding: 'DB',
      migrateToken: 'db-name',
      migrationsDir: 'db/migrations',
      migrationsTable: 'custom"table',
    };
    await expect(readCloudflareD1Migrations(ctx)).resolves.toEqual([
      '0000_init.sql',
      '0001_more.sql',
    ]);
    expect(runner.mock.calls[0][0]).toContain('SELECT name FROM "custom""table" ORDER BY name');
  });

  it('applies migrations through the exact configured D1 target', async () => {
    const runner = vi.fn<CloudflareOperationRunner>().mockReturnValue(ok());
    await applyCloudflareD1Migrations({
      operation: context(runner),
      binding: 'DB',
      migrateToken: 'db-name',
      migrationsDir: 'db/migrations',
      migrationsTable: 'd1_migrations',
    });
    expect(runner.mock.calls[0]).toEqual([
      ['d1', 'migrations', 'apply', 'db-name', '--remote', '-c', '/app/wrangler.jsonc', '--env='],
      { capture: false, input: undefined },
    ]);
  });
});

describe('Cloudflare custom domains', () => {
  it('adds and removes a custom domain while preserving unrelated routes and comments', () => {
    const root = project(`{
  "name": "my-worker",
  "account_id": "account-1",
  // Keep this route.
  "routes": [
    { "pattern": "api.example.com/*", "zone_name": "example.com" }
  ]
}\n`);
    const added = updateWranglerCustomDomain(root, 'app.example.com', 'add');
    expect(added.domains.map((domain) => domain.pattern)).toEqual(['app.example.com']);
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8')).toContain('// Keep this route.');
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8')).toContain('api.example.com/*');
    const removed = updateWranglerCustomDomain(root, 'app.example.com', 'delete');
    expect(removed.domains).toEqual([]);
    expect(readWranglerCustomDomains(root).domains).toEqual([]);
  });

  it('rejects a collision with an existing non-custom route', () => {
    const root = project(
      '{"name":"my-worker","account_id":"account-1","routes":["app.example.com"]}',
    );
    expect(() => updateWranglerCustomDomain(root, 'app.example.com', 'add')).toThrow(
      'already exists as a non-custom route',
    );
  });

  it('rejects a singular route instead of shadowing it with a routes array', () => {
    const root = project(
      '{"name":"my-worker","account_id":"account-1","route":"api.example.com/*"}',
    );
    expect(() => updateWranglerCustomDomain(root, 'app.example.com', 'add')).toThrow(
      'uses the singular "route" field',
    );
  });

  it('synchronizes domains without replaying cron, queue, or workflow triggers', async () => {
    const root = project(`{
  "name": "my-worker",
  "account_id": "account-1",
  "workers_dev": false,
  "triggers": { "crons": ["0 * * * *"] },
  "queues": { "consumers": [{ "queue": "jobs" }] },
  "workflows": [{ "name": "flow", "class_name": "Flow" }]
}\n`);
    let deployedConfig: Record<string, unknown> | undefined;
    const runner = vi.fn<CloudflareOperationRunner>((args) => {
      const configIndex = args.indexOf('-c');
      deployedConfig = JSON.parse(readFileSync(args[configIndex + 1]!, 'utf-8')) as Record<
        string,
        unknown
      >;
      return ok();
    });

    await changeCloudflareDomain(root, 'app.example.com', 'add', runner);

    expect(deployedConfig).toEqual({
      name: 'my-worker',
      account_id: 'account-1',
      workers_dev: false,
      routes: [{ pattern: 'app.example.com', custom_domain: true }],
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('restores the exact local and remote config on trigger failure', async () => {
    const root = project(
      '{"name":"my-worker","account_id":"account-1","routes":[{"pattern":"existing.example.com","custom_domain":true}]}',
    );
    const before = readFileSync(join(root, 'wrangler.jsonc'), 'utf-8');
    const runner = vi
      .fn<CloudflareOperationRunner>()
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'not accepted' })
      .mockReturnValueOnce(ok());
    await expect(changeCloudflareDomain(root, 'app.example.com', 'add', runner)).rejects.toThrow(
      'local config and remote triggers were restored',
    );
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8')).toBe(before);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('reports uncertain remote route state when automatic restore also fails', async () => {
    const root = project(
      '{"name":"my-worker","account_id":"account-1","routes":[{"pattern":"existing.example.com","custom_domain":true}]}',
    );
    const before = readFileSync(join(root, 'wrangler.jsonc'), 'utf-8');
    const runner = vi.fn<CloudflareOperationRunner>().mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'not accepted',
    });

    await expect(changeCloudflareDomain(root, 'app.example.com', 'add', runner)).rejects.toThrow(
      'remote route state may be partially applied',
    );
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8')).toBe(before);
  });

  it('removes the final domain through the authenticated API', async () => {
    const root = project(
      '{"name":"my-worker","account_id":"account-1","routes":[{"pattern":"app.example.com","custom_domain":true}]}',
    );
    const runner = vi.fn<CloudflareOperationRunner>();
    const publishEmpty = vi.fn(async () => undefined);

    await expect(
      changeCloudflareDomain(root, 'app.example.com', 'delete', runner, publishEmpty),
    ).resolves.toMatchObject({ modified: true, domains: [] });

    expect(publishEmpty).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'account-1', workerName: 'my-worker' }),
    );
    expect(runner).not.toHaveBeenCalled();
    expect(readWranglerCustomDomains(root).domains).toEqual([]);
  });

  it('publishes an empty final domain set to the pinned Cloudflare API', async () => {
    const root = project(
      '{"name":"my-worker","account_id":"account-1","routes":[{"pattern":"app.example.com","custom_domain":true}]}',
    );
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-token');
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ success: true, errors: [], messages: [], result: null }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await changeCloudflareDomain(root, 'app.example.com', 'delete', vi.fn());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/my-worker/domains/records',
    );
    expect(init).toMatchObject({
      method: 'PUT',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        override_scope: true,
        override_existing_origin: false,
        override_existing_dns_record: false,
        origins: [],
      }),
      redirect: 'error',
    });
  });

  it('fails closed before deleting the final domain without an API token', async () => {
    const root = project(
      '{"name":"my-worker","account_id":"account-1","routes":[{"pattern":"app.example.com","custom_domain":true}]}',
    );
    const before = readFileSync(join(root, 'wrangler.jsonc'), 'utf-8');
    const runner = vi.fn<CloudflareOperationRunner>();
    vi.stubEnv('CLOUDFLARE_API_TOKEN', '');
    vi.stubEnv('CF_API_TOKEN', '');

    await expect(changeCloudflareDomain(root, 'app.example.com', 'delete', runner)).rejects.toThrow(
      'No local or remote state changed',
    );

    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8')).toBe(before);
    expect(runner).not.toHaveBeenCalled();
  });

  it('lists configured domains without an account mutation', () => {
    const root = project(
      '{"name":"my-worker","account_id":"account-1","routes":[{"pattern":"app.example.com","custom_domain":true}]}',
    );
    expect(listCloudflareDomains(root)).toEqual([
      { pattern: 'app.example.com', customDomain: true },
    ]);
  });
});
