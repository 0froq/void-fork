import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { encodeCloudflareVersionMessage } from '@void/deploy-cloudflare';
import {
  createApplicationRoutes,
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  createPlatformResourceOwnershipMarker,
  PLATFORM_DISABLED_KEY,
  PLATFORM_DISABLED_VALUE,
  recordInstallationResource,
  recordInstallationStep,
  setInstallationDesiredState,
  transitionInstallation,
} from '@void/platform';
import {
  getPlatformRuntimeDirectory,
  platformDatabaseSchemaDigest,
  readPlatformRuntimeManifest,
  type PlatformRuntimeDatabaseManifest,
} from '@void/platform/installer';
import { join } from 'pathslash';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  hyperdriveOriginConfigHash,
  hyperdriveOriginFromConnectionString,
} from '../../src/cli/platform-cloudflare.ts';
import {
  acquirePlatformDatabaseLifecycleLockConnection,
  classifyPlatformWorkerDeploymentLineage,
  installPlatform,
  claimPlatformDatabaseConnection,
  createPlatformHealthProbeToken,
  createPlatformInstallationSecrets,
  inspectNewPlatformWorker,
  inspectPlatformDatabaseStateConnection,
  inventoryUnmanagedPlatformWorkerTraffic,
  isolatePlatformWorkerCustomDomains,
  mergePlatformWorkerTrafficConfig,
  mergePreservedTriggerRoutes,
  preparePlatformDatabaseConnection,
  PlatformWorkerRecoveryIncompleteError,
  r2BucketConfigHash,
  readPlatformDatabaseLifecycleManifestConnection,
  readActivePlatformWorkerSnapshot,
  recoverFailedPlatformWorkerDeployment,
  retainReplacedInstallationResource,
  resolvePlatformPreviousTriggerConfig,
  resolveBootstrapGitHubId,
  stablePublicEndpointState,
  verifyPlatformHealth,
  withConditionalPlatformWorkerCreate,
  withoutPlatformWorkerTrafficAttachments,
} from '../../src/cli/platform-installer.ts';
import {
  createPlatformInstallPlan,
  platformProvisionIntentHash,
} from '../../src/cli/platform-plan.ts';
import {
  listInstallationManifests,
  writeInstallationManifest,
} from '../../src/cli/platform-registry.ts';

const directories: Array<string> = [];

afterEach(() => {
  delete process.env.VOID_PLATFORM_REGISTRY_DIR;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function planningClient() {
  return {
    verifyToken: async () => {},
    listAccounts: async () => [{ id: 'account', name: 'Account' }],
    getWorkersSubdomain: async () => 'workers-subdomain',
    getKvValue: async () => null,
    getR2Object: async () => null,
    getWorkerPlainTextBindings: async () => ({}),
    listAiGateways: async () => [],
    findZone: async () => ({
      id: 'zone-id',
      name: 'example.com',
      nameServers: [],
      status: 'active',
    }),
    findZoneForHostname: async () => null,
    listDnsRecords: async () => [],
    listKvNamespaces: async () => [],
    listR2Buckets: async () => [],
    listQueues: async () => [],
    listDispatchNamespaces: async () => [],
    listHyperdriveConfigs: async () => [],
    listWorkerNames: async () => [],
    listWorkerDomains: async () => [],
    listWorkerRoutes: async () => [],
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
    server.closeAllConnections();
  });
}

describe('platform installer', () => {
  const claimDatabase = async () => {};
  const acquireDatabaseLifecycleLock = async () => async () => {};

  it('attempts Worker rollback even when closing an unsafe routing gate fails', async () => {
    const events: Array<string> = [];
    const failures = await recoverFailedPlatformWorkerDeployment({
      checkpointUnsafeTraffic: async () => {
        events.push('checkpoint');
      },
      closeRoutingGate: async () => {
        events.push('gate');
        throw new Error('KV unavailable');
      },
      rollback: async () => {
        events.push('rollback');
      },
      unsafeTraffic: true,
    });

    expect(events).toEqual(['gate', 'checkpoint', 'rollback']);
    expect(failures).toEqual(['closing the routing gate failed: KV unavailable']);
  });

  it('creates a new Worker through a conditional API request', async () => {
    const requests: Array<{
      authorization: string | undefined;
      body: string;
      ifNoneMatch: string | undefined;
      method: string | undefined;
      path: string | undefined;
    }> = [];
    const upstream = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        requests.push({
          authorization: request.headers.authorization,
          body,
          ifNoneMatch: request.headers['if-none-match'],
          method: request.method,
          path: request.url,
        });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"success":true,"result":{"id":"version"}}');
      });
    });
    const upstreamOrigin = await listen(upstream);
    try {
      await expect(
        withConditionalPlatformWorkerCreate(
          'account',
          'void-api',
          async (apiBaseUrl) => {
            const inspection = await fetch(`${apiBaseUrl}/accounts/account/workers/subdomain`, {
              headers: { Authorization: 'Bearer secret-token' },
            });
            expect(inspection.ok).toBe(true);
            const created = await fetch(`${apiBaseUrl}/accounts/account/workers/scripts/void-api`, {
              body: 'worker bundle',
              headers: {
                Authorization: 'Bearer secret-token',
                'Content-Type': 'text/plain',
              },
              method: 'PUT',
            });
            expect(created.ok).toBe(true);
            return 'created';
          },
          `${upstreamOrigin}/client/v4`,
        ),
      ).resolves.toBe('created');
      expect(requests).toEqual([
        {
          authorization: 'Bearer secret-token',
          body: '',
          ifNoneMatch: undefined,
          method: 'GET',
          path: '/client/v4/accounts/account/workers/subdomain',
        },
        {
          authorization: 'Bearer secret-token',
          body: 'worker bundle',
          ifNoneMatch: '*',
          method: 'PUT',
          path: '/client/v4/accounts/account/workers/scripts/void-api',
        },
      ]);
    } finally {
      await close(upstream);
    }
  });

  it('fails a raced Worker create without exposing credentials', async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(412, { 'Content-Type': 'application/json' });
      response.end('{"success":false,"errors":[{"message":"Bearer secret-token already exists"}]}');
    });
    const upstreamOrigin = await listen(upstream);
    try {
      const failure = withConditionalPlatformWorkerCreate(
        'account',
        'void-api',
        async (apiBaseUrl) => {
          await fetch(`${apiBaseUrl}/accounts/account/workers/scripts/void-api`, {
            body: 'worker bundle',
            headers: { Authorization: 'Bearer secret-token' },
            method: 'PUT',
          });
        },
        `${upstreamOrigin}/client/v4`,
      );
      await expect(failure).rejects.toThrow('created concurrently (HTTP 412)');
      await expect(failure).rejects.not.toThrow('secret-token');
    } finally {
      await close(upstream);
    }
  });

  it('blocks mutations before the guarded Worker create and closes the proxy', async () => {
    let proxyBaseUrl = '';
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"success":true,"result":{}}');
    });
    const upstreamOrigin = await listen(upstream);
    try {
      await expect(
        withConditionalPlatformWorkerCreate(
          'account',
          'void-api',
          async (apiBaseUrl) => {
            proxyBaseUrl = apiBaseUrl;
            const response = await fetch(
              `${apiBaseUrl}/accounts/account/workers/scripts/other-worker`,
              { body: 'unconditional bundle', method: 'PUT' },
            );
            expect(response.status).toBe(409);
          },
          `${upstreamOrigin}/client/v4`,
        ),
      ).rejects.toThrow('unexpected mutation PUT');
      await expect(fetch(`${proxyBaseUrl}/accounts/account/workers/subdomain`)).rejects.toThrow();
    } finally {
      await close(upstream);
    }
  });

  it('accepts only an installer deployment with the expected predecessor', () => {
    const ours = {
      id: 'deployment-ours',
      versions: [{ percentage: 100, versionId: 'version-ours' }],
    };
    const previous = {
      id: 'deployment-previous',
      versions: [{ percentage: 100, versionId: 'version-previous' }],
    };
    const intervening = {
      id: 'deployment-intervening',
      versions: [{ percentage: 100, versionId: 'version-intervening' }],
    };

    expect(classifyPlatformWorkerDeploymentLineage([ours], 'version-ours', null)).toEqual({
      deploymentId: 'deployment-ours',
      kind: 'committed',
    });
    expect(
      classifyPlatformWorkerDeploymentLineage(
        [ours, previous],
        'version-ours',
        'deployment-previous',
      ),
    ).toEqual({ deploymentId: 'deployment-ours', kind: 'committed' });
    expect(
      classifyPlatformWorkerDeploymentLineage(
        [ours, intervening, previous],
        'version-ours',
        'deployment-previous',
      ),
    ).toEqual({ deploymentId: 'deployment-ours', kind: 'intervening' });
    expect(
      classifyPlatformWorkerDeploymentLineage(
        [intervening, ours, previous],
        'version-ours',
        'deployment-previous',
      ),
    ).toEqual({ kind: 'concurrent-after' });
  });

  it('binds an existing Worker snapshot to its immutable ownership marker', async () => {
    const versionId = '11111111-1111-4111-8111-111111111111';
    const marker = '{"installationId":"ours"}';
    const triggerConfig = {
      crons: [],
      preview_urls: true,
      queueConsumers: [],
      routes: [],
      workers_dev: true,
      workflows: [],
    };
    const runner = async (args: ReadonlyArray<string>) => ({
      status: 0,
      stderr: '',
      stdout:
        args[0] === 'deployments'
          ? JSON.stringify({ versions: [{ percentage: 100, version_id: versionId }] })
          : JSON.stringify({
              annotations: {
                'workers/message': encodeCloudflareVersionMessage([], triggerConfig),
              },
              resources: {
                bindings: [{ name: 'PLATFORM_OWNERSHIP_MARKER', type: 'plain_text', text: marker }],
              },
            }),
    });

    await expect(
      readActivePlatformWorkerSnapshot('wrangler.json', 'account', 'worker', marker, runner),
    ).resolves.toEqual({ triggerConfig, versionId });
    await expect(
      readActivePlatformWorkerSnapshot(
        'wrangler.json',
        'account',
        'worker',
        '{"installationId":"replacement"}',
        runner,
      ),
    ).rejects.toThrow('does not belong to this installation');
  });

  it('rejects a Worker replacement during immutable version inspection', async () => {
    const versions = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ];
    const runner = async (args: ReadonlyArray<string>) => ({
      status: 0,
      stderr: '',
      stdout:
        args[0] === 'deployments'
          ? JSON.stringify({ versions: [{ percentage: 100, version_id: versions.shift() }] })
          : JSON.stringify({
              resources: {
                bindings: [{ name: 'PLATFORM_OWNERSHIP_MARKER', type: 'plain_text', text: 'ours' }],
              },
            }),
    });

    await expect(
      readActivePlatformWorkerSnapshot('wrangler.json', 'account', 'worker', 'ours', runner),
    ).rejects.toThrow('changed concurrently');
  });

  it('preserves unmanaged Worker routes and custom domains across deploy and rollback', async () => {
    const plan = await createPlatformInstallPlan(
      planningClient(),
      {
        accountId: 'account',
        applicationDomain: 'apps.example.com',
        controlPlaneDomain: 'api.example.com',
        dedicatedZone: false,
        displayName: 'Example',
        installationSlug: 'example',
        zoneName: 'example.com',
      },
      null,
    );
    const managedDispatchPattern = createApplicationRoutes(plan.deployment.application)[0]!.pattern;
    const client = {
      listWorkerDomains: async () => [
        {
          hostname: 'api.example.com',
          id: 'managed-api',
          service: plan.deployment.resources.apiWorker,
        },
        {
          hostname: 'admin.example.net',
          id: 'manual-api',
          service: plan.deployment.resources.apiWorker,
        },
        { hostname: 'other.example.net', id: 'other', service: 'unrelated-worker' },
      ],
      listWorkerServiceRoutes: async (_account: string, worker: string) =>
        worker === plan.deployment.resources.dispatchWorker
          ? [
              { pattern: managedDispatchPattern, zoneName: 'example.com' },
              { pattern: 'manual.example.net/*', zoneName: 'example.net' },
            ]
          : [],
    };

    const apiTraffic = await inventoryUnmanagedPlatformWorkerTraffic(
      client,
      plan,
      plan.deployment.resources.apiWorker,
    );
    expect(apiTraffic).toEqual([{ pattern: 'admin.example.net', custom_domain: true }]);
    const dispatchTraffic = await inventoryUnmanagedPlatformWorkerTraffic(
      client,
      plan,
      plan.deployment.resources.dispatchWorker,
    );
    expect(dispatchTraffic).toEqual([
      { pattern: 'manual.example.net/*', zone_name: 'example.net' },
    ]);

    const nextConfig = mergePlatformWorkerTrafficConfig(
      { routes: [{ pattern: managedDispatchPattern, zone_name: 'example.com' }] },
      dispatchTraffic,
    );
    expect(nextConfig.routes).toEqual([
      { pattern: managedDispatchPattern, zone_name: 'example.com' },
      { pattern: 'manual.example.net/*', zone_name: 'example.net' },
    ]);
    expect(
      mergePreservedTriggerRoutes(
        {
          crons: [],
          preview_urls: true,
          queueConsumers: [],
          routes: [{ pattern: managedDispatchPattern, zone_name: 'example.com' }],
          workers_dev: true,
          workflows: [],
        },
        dispatchTraffic,
      ).routes,
    ).toEqual(nextConfig.routes);

    expect(
      isolatePlatformWorkerCustomDomains({
        routes: [
          { pattern: 'api.example.com', custom_domain: true, zone_name: 'example.com' },
          { pattern: 'apps.example.com/*', zone_name: 'example.com' },
        ],
      }),
    ).toEqual({
      customDomains: [{ hostname: 'api.example.com', zoneName: 'example.com' }],
      wranglerConfig: {
        routes: [{ pattern: 'apps.example.com/*', zone_name: 'example.com' }],
      },
    });

    expect(
      withoutPlatformWorkerTrafficAttachments({
        name: 'void-dispatch',
        route: 'legacy.example.com/*',
        routes: [
          { pattern: 'apps.example.com/*', zone_name: 'example.com' },
          { pattern: 'manual.example.net/*', zone_name: 'example.net' },
        ],
      }),
    ).toEqual({ name: 'void-dispatch' });
  });

  it('requires the installation ownership marker before managing a new Worker', async () => {
    const manifest = createPlatformInstallationManifest({
      account: { id: 'account', name: 'Account' },
      createdAt: '2026-09-14T00:00:00.000Z',
      deployment: createPlatformDeploymentManifest({
        application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
        displayName: 'Example',
        installationSlug: 'example',
      }),
      id: 'example-a1b2c3d4',
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
    });
    const marker = createPlatformResourceOwnershipMarker({
      accountId: 'account',
      installationId: manifest.id,
      ownershipNonce: manifest.ownershipNonce,
      resourceId: 'void-example-api',
      resourceKey: 'api-worker',
      resourceKind: 'worker',
      resourceName: 'void-example-api',
    });
    const workerClient = {
      getWorkerPlainTextBindings: async () => ({
        PLATFORM_OWNERSHIP_MARKER: JSON.stringify(marker),
      }),
      listWorkerNames: async () => ['void-example-api'],
    };

    await expect(
      inspectNewPlatformWorker(workerClient, 'account', manifest, 'api-worker', 'void-example-api'),
    ).resolves.toBe('owned');

    workerClient.getWorkerPlainTextBindings = async () => ({
      PLATFORM_OWNERSHIP_MARKER: JSON.stringify({ ...marker, ownershipNonce: 'replacement' }),
    });
    await expect(
      inspectNewPlatformWorker(workerClient, 'account', manifest, 'api-worker', 'void-example-api'),
    ).rejects.toThrow('refusing to treat it as installer-owned');

    workerClient.listWorkerNames = async () => [];
    await expect(
      inspectNewPlatformWorker(workerClient, 'account', manifest, 'api-worker', 'void-example-api'),
    ).resolves.toBe('missing');
  });

  it('keeps disabled lifecycle traffic authoritative over stale Worker metadata', () => {
    const installed = {
      ...createPlatformInstallationManifest({
        account: { id: 'account', name: 'Account' },
        createdAt: '2026-09-14T00:00:00.000Z',
        deployment: createPlatformDeploymentManifest({
          application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
          displayName: 'Example',
          installationSlug: 'example',
        }),
        id: 'example-a1b2c3d4',
        ownershipNonce: '0123456789abcdef0123456789abcdef',
        platformVersion: '1.0.0',
      }),
      status: 'installed' as const,
    };
    const failedDisable = {
      ...setInstallationDesiredState(installed, 'disabled', '2026-09-14T00:00:02.000Z'),
      status: 'failed' as const,
    };
    expect(stablePublicEndpointState(failedDisable)).toBe(false);

    const interruptedFreshInstall = {
      ...installed,
      status: 'failed' as const,
    };
    expect(interruptedFreshInstall.desiredState).toBe('enabled');
    expect(stablePublicEndpointState(interruptedFreshInstall)).toBe(false);
    expect(stablePublicEndpointState(installed)).toBe(true);

    const previous = resolvePlatformPreviousTriggerConfig(
      {
        crons: ['0 * * * *'],
        preview_urls: true,
        queueConsumers: [{ queue: 'usage' }],
        routes: [{ pattern: 'api.example.com', custom_domain: true }],
        workers_dev: true,
        workflows: [{ name: 'maintenance' }],
      },
      {
        crons: ['new cron must not replace version state'],
        preview_urls: false,
        queueConsumers: [],
        routes: [],
        workers_dev: false,
        workflows: [],
      },
      false,
    );
    expect(previous).toEqual({
      crons: ['0 * * * *'],
      preview_urls: false,
      queueConsumers: [{ queue: 'usage' }],
      routes: [],
      workers_dev: false,
      workflows: [{ name: 'maintenance' }],
    });
  });

  it('verifies API, discovery, proxy, and dispatch before committing a cutover', async () => {
    const requests: Array<{ headers: Headers; url: string }> = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ headers: new Headers(init?.headers), url });
      return Response.json(
        url.endsWith('/.well-known/void-platform')
          ? { installationId: 'example-a1b2c3d4', platformVersion: '1.2.3' }
          : { ok: true },
      );
    }) as typeof fetch;

    await verifyPlatformHealth(
      'https://api.example.com',
      'example-a1b2c3d4',
      'https://proxy.example.com',
      'apps.example.com',
      '1.2.3',
      'probe-token',
      fetcher,
    );

    expect(requests.map((entry) => entry.url)).toEqual([
      'https://api.example.com/health',
      'https://api.example.com/.well-known/void-platform',
      'https://proxy.example.com/health',
      'https://test.apps.example.com/health',
    ]);
    expect(
      requests.every((entry) => entry.headers.get('X-Void-Platform-Probe') === 'probe-token'),
    ).toBe(true);
    expect(requests.every((entry) => !entry.headers.has('X-Health-Check'))).toBe(true);
  });

  it('derives an installation-specific high-entropy health probe token', () => {
    const first = createPlatformHealthProbeToken('a'.repeat(43));
    const second = createPlatformHealthProbeToken('b'.repeat(43));
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain('a'.repeat(20));
  });

  it('rejects a cutover when the proxy is unhealthy', async () => {
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://proxy.example.com/health') {
        return new Response('unhealthy', { status: 500 });
      }
      return Response.json(
        url.endsWith('/.well-known/void-platform')
          ? { installationId: 'example-a1b2c3d4', platformVersion: '1.2.3' }
          : { ok: true },
      );
    }) as typeof fetch;

    await expect(
      verifyPlatformHealth(
        'https://api.example.com',
        'example-a1b2c3d4',
        'https://proxy.example.com',
        'apps.example.com',
        '1.2.3',
        'probe-token',
        fetcher,
      ),
    ).rejects.toThrow('Proxy health check failed');
  });

  it('requires live PostgreSQL migration history to be an exact package prefix', async () => {
    const database = readPlatformRuntimeManifest().database;
    const first = database.migrations[0]!;
    const second = database.migrations[1]!;
    const connection = migrationConnection([
      { created_at: first.timestampMillis, hash: first.sha256, id: 1 },
      { created_at: second.timestampMillis, hash: second.sha256, id: 2 },
    ]);

    const state = await inspectPlatformDatabaseStateConnection(connection, database);
    expect(state.schemaDigest).toBe(
      platformDatabaseSchemaDigest(database.lineage, database.migrations.slice(0, 2)),
    );
    expect(state.pendingMigrations).toEqual(database.migrations.slice(2));

    connection.rows[1] = { ...connection.rows[1]!, hash: '0'.repeat(64) };
    await expect(inspectPlatformDatabaseStateConnection(connection, database)).rejects.toThrow(
      'not an exact prefix',
    );

    connection.rows[1] = {
      ...connection.rows[1]!,
      created_at: first.timestampMillis,
      hash: second.sha256,
    };
    await expect(inspectPlatformDatabaseStateConnection(connection, database)).rejects.toThrow(
      'duplicated or not strictly ordered',
    );
  });

  it('applies a fresh database transactionally without a rollback edge', async () => {
    const database = migrationSubset(2);
    const connection = migrationConnection();

    const result = await preparePlatformDatabaseConnection(
      connection,
      getPlatformRuntimeDirectory(),
      database,
      null,
      false,
    );

    expect(result).toEqual({
      appliedMigrations: 2,
      previousSchemaDigest: platformDatabaseSchemaDigest(database.lineage, []),
      schemaDigest: database.schemaDigest,
    });
    expect(connection.rows).toEqual(
      database.migrations.map((migration, index) => ({
        created_at: migration.timestampMillis,
        hash: migration.sha256,
        id: index + 1,
      })),
    );
    expect(connection.queries).toContain('BEGIN');
    expect(connection.queries).toContain('COMMIT');
    expect(connection.queries).not.toContain('ROLLBACK');
  });

  it('requires an exact rollback compatibility edge before an existing install migrates', async () => {
    const base = migrationSubset(1);
    const sourceDigest = platformDatabaseSchemaDigest(base.lineage, []);
    const connection = migrationConnection();

    await expect(
      preparePlatformDatabaseConnection(
        connection,
        getPlatformRuntimeDirectory(),
        base,
        '0.10.13',
        true,
      ),
    ).rejects.toThrow('cannot safely roll back');
    expect(connection.queries).not.toContain('BEGIN');

    const compatible = {
      ...base,
      rollbackSafeFrom: [{ platformVersion: '0.10.13', schemaDigest: sourceDigest }],
    } satisfies PlatformRuntimeDatabaseManifest;
    await expect(
      preparePlatformDatabaseConnection(
        connection,
        getPlatformRuntimeDirectory(),
        compatible,
        '0.10.13',
        true,
      ),
    ).resolves.toMatchObject({ appliedMigrations: 1, schemaDigest: compatible.schemaDigest });
  });

  it('rolls back every pending migration when one statement fails', async () => {
    const database = migrationSubset(2);
    const connection = migrationConnection([], 'CREATE TABLE "oauth_accounts"');

    await expect(
      preparePlatformDatabaseConnection(
        connection,
        getPlatformRuntimeDirectory(),
        database,
        null,
        false,
      ),
    ).rejects.toThrow('migration failed');
    expect(connection.queries).toContain('ROLLBACK');
    expect(connection.queries).not.toContain('COMMIT');
    expect(connection.rows).toEqual([]);
  });

  it('serializes lifecycle changes with the claimed PostgreSQL database', async () => {
    const queries: Array<{ sql: string; values?: ReadonlyArray<unknown> }> = [];
    const connection = {
      query: async <Row extends Record<string, unknown>>(
        sql: string,
        values?: ReadonlyArray<unknown>,
      ) => {
        queries.push({ sql, values });
        if (sql.includes('FROM "__void_platform_installation"')) {
          return {
            rows: [
              { installation_id: 'install-one', ownership_nonce: 'nonce-one' },
            ] as unknown as ReadonlyArray<Row>,
          };
        }
        if (sql.includes('pg_try_advisory_lock')) {
          return { rows: [{ acquired: true }] as unknown as ReadonlyArray<Row> };
        }
        return { rows: [] as ReadonlyArray<Row> };
      },
    };
    const release = await acquirePlatformDatabaseLifecycleLockConnection(
      connection,
      'install-one',
      'nonce-one',
    );
    await release();
    await release();

    expect(queries.filter(({ sql }) => sql.includes('pg_try_advisory_lock'))).toHaveLength(1);
    expect(queries.filter(({ sql }) => sql.includes('pg_advisory_unlock'))).toHaveLength(1);
    expect(queries.find(({ sql }) => sql.includes('pg_try_advisory_lock'))?.values).toEqual([
      'void-platform-lifecycle-v1:install-one:nonce-one',
    ]);
  });

  it('reads and validates the authoritative lifecycle checkpoint without mutating it', async () => {
    const ownershipNonce = '0123456789abcdef0123456789abcdef';
    const manifest = createPlatformInstallationManifest({
      account: { id: 'account', name: 'Account' },
      createdAt: '2026-09-14T00:00:00.000Z',
      deployment: createPlatformDeploymentManifest({
        application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
        displayName: 'Example',
        installationSlug: 'example',
      }),
      id: 'install-one',
      ownershipNonce,
      platformVersion: '1.0.0',
    });
    const queries: Array<string> = [];
    const connection = {
      query: async <Row extends Record<string, unknown>>(sql: string) => {
        queries.push(sql);
        if (sql.includes('to_regclass')) {
          return {
            rows: [{ relation: '__void_platform_installation' }] as unknown as ReadonlyArray<Row>,
          };
        }
        return {
          rows: [
            {
              installation_id: 'install-one',
              lifecycle_manifest: manifest,
              ownership_nonce: ownershipNonce,
            },
          ] as unknown as ReadonlyArray<Row>,
        };
      },
    };

    await expect(
      readPlatformDatabaseLifecycleManifestConnection(connection, 'install-one', ownershipNonce),
    ).resolves.toEqual(manifest);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatch(/^SELECT/);
  });

  it('treats a missing database ownership table as an unclaimed install', async () => {
    const queries: Array<string> = [];
    const connection = {
      query: async <Row extends Record<string, unknown>>(sql: string) => {
        queries.push(sql);
        return { rows: [{ relation: null }] as unknown as ReadonlyArray<Row> };
      },
    };

    await expect(
      readPlatformDatabaseLifecycleManifestConnection(
        connection,
        'install-one',
        '0123456789abcdef0123456789abcdef',
      ),
    ).resolves.toBeNull();
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('to_regclass');
  });

  it('reads and writes authoritative lifecycle state while holding the database lock', async () => {
    let manifest = createPlatformInstallationManifest({
      account: { id: 'account', name: 'Account' },
      createdAt: '2026-09-14T00:00:00.000Z',
      deployment: createPlatformDeploymentManifest({
        application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
        displayName: 'Example',
        installationSlug: 'example',
      }),
      id: 'install-one',
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
    });
    manifest = transitionInstallation(manifest, 'planned', '2026-09-14T00:00:01.000Z');
    const queries: Array<{ sql: string; values?: ReadonlyArray<unknown> }> = [];
    const connection = {
      query: async <Row extends Record<string, unknown>>(
        sql: string,
        values?: ReadonlyArray<unknown>,
      ) => {
        queries.push({ sql, values });
        if (sql.includes('FROM "__void_platform_installation"')) {
          return {
            rows: [
              {
                installation_id: manifest.id,
                lifecycle_manifest: manifest,
                ownership_nonce: manifest.ownershipNonce,
              },
            ] as unknown as ReadonlyArray<Row>,
          };
        }
        if (sql.includes('pg_try_advisory_lock')) {
          return { rows: [{ acquired: true }] as unknown as ReadonlyArray<Row> };
        }
        if (sql.includes('UPDATE "__void_platform_installation"')) {
          return { rows: [{ singleton: true }] as unknown as ReadonlyArray<Row> };
        }
        return { rows: [] as ReadonlyArray<Row> };
      },
    };

    const lock = await acquirePlatformDatabaseLifecycleLockConnection(
      connection,
      manifest.id,
      manifest.ownershipNonce,
    );
    expect(lock.authoritativeManifest).toEqual(manifest);
    const next = transitionInstallation(manifest, 'provisioning', '2026-09-14T00:00:02.000Z');
    await lock.checkpoint!(next);
    expect(lock.authoritativeManifest).toEqual(next);
    expect(
      queries.find(({ sql }) => sql.includes('UPDATE "__void_platform_installation"'))?.values,
    ).toEqual([JSON.stringify(next), manifest.id, manifest.ownershipNonce]);
    await lock();
  });

  it('claims only an empty database or an existing matching claim', async () => {
    const queries: Array<string> = [];
    const connection = (claim: ReadonlyArray<Record<string, string>>, hasContents: boolean) => ({
      query: async <Row extends Record<string, unknown>>(sql: string) => {
        queries.push(sql);
        if (sql.includes('SELECT "installation_id"')) {
          return { rows: claim as ReadonlyArray<Row> };
        }
        if (sql.includes('FROM "pg_catalog"."pg_tables"')) {
          return {
            rows: (hasContents
              ? [{ schemaname: 'public', tablename: 'users' }]
              : []) as unknown as ReadonlyArray<Row>,
          };
        }
        return { rows: [] as ReadonlyArray<Row> };
      },
    });
    await expect(
      claimPlatformDatabaseConnection(connection([], false), 'install-one', 'nonce-one'),
    ).resolves.toBeUndefined();
    await expect(
      claimPlatformDatabaseConnection(
        connection([{ installation_id: 'install-one', ownership_nonce: 'nonce-one' }], true),
        'install-one',
        'nonce-one',
      ),
    ).resolves.toBeUndefined();
    await expect(
      claimPlatformDatabaseConnection(connection([], true), 'install-two', 'nonce-two'),
    ).rejects.toThrow('non-empty PostgreSQL database');
    expect(queries.some((sql) => sql === 'ROLLBACK')).toBe(true);
  });
  it('resolves the initial administrator to an immutable GitHub account id', async () => {
    const requests: Array<string> = [];
    await expect(
      resolveBootstrapGitHubId('Octocat', async (input) => {
        requests.push(String(input));
        return Response.json({ id: 583231 });
      }),
    ).resolves.toBe('583231');
    expect(requests).toEqual(['https://api.github.com/users/Octocat']);
  });

  it('never rotates runtime keys while resuming an existing installation', () => {
    const input = {
      bootstrapGitHubId: '583231',
      bootstrapGitHubLogin: 'octocat',
      cloudflareApiToken: 'cf-token',
      databaseUrl: 'postgres://user:password@db.example.com/void',
      existingInstallation: true,
      githubClientId: 'github-id',
      githubClientSecret: 'github-secret',
      r2AccessKeyId: 'r2-id',
      r2SecretAccessKey: 'r2-secret',
    };
    expect(() => createPlatformInstallationSecrets(input)).toThrow(
      'VOID_PLATFORM_JWT_SECRET is required',
    );
    expect(() =>
      createPlatformInstallationSecrets({ ...input, jwtSecret: 'existing-jwt-secret' }),
    ).toThrow('VOID_PLATFORM_PROJECT_SECRET_KEY is required');

    const projectSecretKey = Buffer.alloc(32, 7).toString('base64');
    expect(
      createPlatformInstallationSecrets({
        ...input,
        jwtSecret: 'existing-jwt-secret',
        projectSecretKey,
      }),
    ).toMatchObject({ jwtSecret: 'existing-jwt-secret', projectSecretKey });

    const recoveredProjectSecretKey = Buffer.alloc(32, 9).toString('base64');
    expect(
      createPlatformInstallationSecrets({
        ...input,
        checkpoint: {
          jwtSecret: 'recovered-jwt-secret',
          projectSecretKey: recoveredProjectSecretKey,
        },
        jwtSecret: 'wrong-exported-jwt-secret',
        projectSecretKey: Buffer.alloc(32, 3).toString('base64'),
      }),
    ).toMatchObject({
      jwtSecret: 'recovered-jwt-secret',
      projectSecretKey: recoveredProjectSecretKey,
    });
  });

  it('does not checkpoint failure when another host owns the lifecycle lock', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-platform-lock-contender-test-'));
    directories.push(directory);
    process.env.VOID_PLATFORM_REGISTRY_DIR = directory;
    const plan = await createPlatformInstallPlan(
      planningClient(),
      {
        accountId: 'account',
        applicationDomain: 'apps.example.com',
        controlPlaneDomain: '',
        dedicatedZone: false,
        displayName: 'Example',
        installationSlug: 'example',
        zoneName: 'example.com',
      },
      null,
    );
    const client = {
      createAiGateway: async () => ({ id: 'unused', name: 'unused' }),
      createDispatchNamespace: async () => ({ id: 'unused', name: 'unused' }),
      createDnsRecord: async () => ({
        content: '100::',
        id: 'unused',
        name: 'unused',
        proxied: true,
        type: 'AAAA',
      }),
      createHyperdrive: async () => ({ id: 'unused', name: 'unused' }),
      createKvNamespace: async () => ({ id: 'unused', name: 'unused' }),
      createQueue: async () => ({ id: 'unused', name: 'unused' }),
      createR2Bucket: async () => ({ id: 'unused', name: 'unused' }),
      createZone: async () => ({ id: 'unused', name: 'unused', nameServers: [], status: 'active' }),
      putKvValue: async () => {},
      putR2Object: async () => {},
    };

    await expect(
      installPlatform(
        plan,
        createPlatformInstallationSecrets({
          bootstrapGitHubId: '583231',
          bootstrapGitHubLogin: 'octocat',
          cloudflareApiToken: 'cf-token',
          databaseUrl: 'postgres://user:password@db.example.com/void',
          githubClientId: 'github-id',
          githubClientSecret: 'github-secret',
          r2AccessKeyId: 'r2-id',
          r2SecretAccessKey: 'r2-secret',
        }),
        null,
        {
          acquireDatabaseLifecycleLock: async () => {
            throw new Error('another host owns the lock');
          },
          claimDatabase,
          client,
          revalidateBeforeWorkerDeploy: async () => {},
        },
      ),
    ).rejects.toThrow('another host owns the lock');
    expect(listInstallationManifests(directory)[0]).toMatchObject({
      resources: [],
      status: 'planned',
    });
  });

  it('validates a resume only after reading the authoritative database checkpoint', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-platform-authoritative-resume-test-'));
    directories.push(directory);
    process.env.VOID_PLATFORM_REGISTRY_DIR = directory;
    const deployment = createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      displayName: 'Example',
      installationSlug: 'example',
    });
    let manifest = createPlatformInstallationManifest({
      account: { id: 'account', name: 'Account' },
      createdAt: '2026-09-14T00:00:00.000Z',
      deployment,
      id: 'example-a1b2c3d4',
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
    });
    manifest = transitionInstallation(manifest, 'planned', '2026-09-14T00:00:01.000Z');
    manifest = transitionInstallation(manifest, 'provisioning', '2026-09-14T00:00:02.000Z');
    const routingName = deployment.resources.routingKv;
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-09-14T00:00:03.000Z',
        key: 'provision-intent:routing-kv',
        resultHash: platformProvisionIntentHash(
          manifest,
          'routing-kv',
          'kv-namespace',
          routingName,
        ),
      },
      '2026-09-14T00:00:03.000Z',
    );
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: 'hash',
        id: 'routing-kv-id',
        key: 'routing-kv',
        kind: 'kv-namespace',
        name: routingName,
        ownership: 'created',
        state: 'ready',
      },
      '2026-09-14T00:00:04.000Z',
    );
    manifest = transitionInstallation(manifest, 'failed', '2026-09-14T00:00:05.000Z');
    writeInstallationManifest(manifest);
    const planner = {
      ...planningClient(),
      listKvNamespaces: async (_accountId: string, title?: string) =>
        title === routingName ? [{ id: 'routing-kv-id', name: routingName }] : [],
    };
    const plan = await createPlatformInstallPlan(
      planner,
      {
        accountId: 'account',
        applicationDomain: 'apps.example.com',
        controlPlaneDomain: '',
        dedicatedZone: false,
        displayName: 'Example',
        installationSlug: 'example',
        zoneName: 'example.com',
      },
      manifest,
    );
    let released = false;
    const lock = Object.assign(
      async () => {
        released = true;
      },
      { authoritativeManifest: manifest },
    );

    await expect(
      installPlatform(
        plan,
        createPlatformInstallationSecrets({
          bootstrapGitHubId: '583231',
          bootstrapGitHubLogin: 'octocat',
          cloudflareApiToken: 'cf-token',
          databaseUrl: 'postgres://user:password@db.example.com/void',
          githubClientId: 'github-id',
          githubClientSecret: 'github-secret',
          r2AccessKeyId: 'r2-id',
          r2SecretAccessKey: 'r2-secret',
        }),
        manifest,
        {
          acquireDatabaseLifecycleLock: async () => lock,
          claimDatabase,
          client: {
            createAiGateway: async () => ({ id: 'unused', name: 'unused' }),
            createDispatchNamespace: async () => ({ id: 'unused', name: 'unused' }),
            createDnsRecord: async () => ({
              content: '100::',
              id: 'unused',
              name: 'unused',
              proxied: true,
              type: 'AAAA',
            }),
            createHyperdrive: async () => ({ id: 'unused', name: 'unused' }),
            createKvNamespace: async () => ({ id: 'unused', name: 'unused' }),
            createQueue: async () => ({ id: 'unused', name: 'unused' }),
            createR2Bucket: async () => ({ id: 'unused', name: 'unused' }),
            createZone: async () => ({
              id: 'unused',
              name: 'unused',
              nameServers: [],
              status: 'active',
            }),
            putKvValue: async () => {},
            putR2Object: async () => {},
          },
          revalidateBeforeWorkerDeploy: async () => {},
          verifyExistingOwnership: async (candidate, databaseCheckpointExists) => {
            expect(candidate).toEqual(manifest);
            expect(databaseCheckpointExists).toBe(true);
            throw new Error('ownership-checked');
          },
        },
      ),
    ).rejects.toThrow('ownership-checked');
    expect(released).toBe(true);
  });

  it('checkpoints every resource and removes pending secrets only after verification', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-platform-installer-test-'));
    directories.push(directory);
    process.env.VOID_PLATFORM_REGISTRY_DIR = directory;
    const plan = await createPlatformInstallPlan(
      planningClient(),
      {
        accountId: 'account',
        applicationDomain: 'apps.example.com',
        controlPlaneDomain: '',
        dedicatedZone: false,
        displayName: 'Example',
        installationSlug: 'example',
        zoneName: 'example.com',
      },
      null,
    );
    let resourceIndex = 0;
    const created = async (_account: string, name: string) => ({
      id: `resource-${resourceIndex++}`,
      name,
    });
    const deployed: Array<string> = [];
    const deployedTrafficStates: Array<unknown> = [];
    let apiSecrets: Record<string, string> | null = null;
    let r2OwnershipMarker = '';
    const routingValues = new Map<string, string>();
    const lifecycleEvents: Array<string> = [];
    let remoteManifest = '';
    const databaseClaims: Array<[string, string]> = [];
    const result = await installPlatform(
      plan,
      createPlatformInstallationSecrets({
        bootstrapGitHubId: '583231',
        bootstrapGitHubLogin: 'octocat',
        cloudflareApiToken: 'cf-token',
        databaseUrl: 'postgres://user:password@db.example.com/void',
        githubClientId: 'github-id',
        githubClientSecret: 'github-secret',
        r2AccessKeyId: 'r2-id',
        r2SecretAccessKey: 'r2-secret',
      }),
      null,
      {
        acquireDatabaseLifecycleLock,
        claimDatabase: async (_url, installationId, ownershipNonce) => {
          databaseClaims.push([installationId, ownershipNonce]);
        },
        client: {
          createAiGateway: created,
          createDnsRecord: async (_zone, name) => ({
            content: '100::',
            id: `resource-${resourceIndex++}`,
            name,
            proxied: true,
            type: 'AAAA',
          }),
          createZone: async () => {
            throw new Error('existing zone must not be created');
          },
          createKvNamespace: created,
          createR2Bucket: created,
          createQueue: created,
          createDispatchNamespace: created,
          createHyperdrive: async (account, name) => created(account, name),
          deleteKvValue: async (_account, _namespace, key) => {
            lifecycleEvents.push(`delete:${key}`);
            routingValues.delete(key);
          },
          putKvValue: async (_account, _namespace, key, value) => {
            routingValues.set(key, value);
            if (key === PLATFORM_DISABLED_KEY) {
              lifecycleEvents.push(`put:${key}`);
            }
            if (key === '__void/platform/installation/v1') {
              remoteManifest = value;
            }
          },
          putR2Object: async (_account, _bucket, _key, value) => {
            r2OwnershipMarker = value;
          },
        },
        deployWorker: async (config, secrets) => {
          expect(routingValues.get(PLATFORM_DISABLED_KEY)).toBe(PLATFORM_DISABLED_VALUE);
          lifecycleEvents.push(`deploy:${String(config.name)}`);
          deployed.push(String(config.name));
          deployedTrafficStates.push(
            (config.vars as Record<string, unknown>).PLATFORM_TRAFFIC_STATE,
          );
          if (String(config.name).endsWith('-api')) {
            apiSecrets = secrets;
          }
        },
        migrateDatabase: async () => {},
        revalidateBeforeWorkerDeploy: async () => {},
        verifyHealth: async () => {
          expect(routingValues.get(PLATFORM_DISABLED_KEY)).toBe(
            lifecycleEvents.includes('verify') ? undefined : PLATFORM_DISABLED_VALUE,
          );
          lifecycleEvents.push('verify');
        },
      },
    );

    expect(result.manifest.status).toBe('installed');
    expect(result.manifest.steps.some((step) => step.key === 'adoption-intent:zone')).toBe(true);
    expect(databaseClaims).toEqual([[result.manifest.id, result.manifest.ownershipNonce]]);
    expect(result.manifest.resources).toHaveLength(15);
    expect(deployed).toEqual([
      result.manifest.deployment.resources.apiWorker,
      result.manifest.deployment.resources.proxyWorker,
      result.manifest.deployment.resources.tailWorker,
      result.manifest.deployment.resources.dispatchWorker,
      result.manifest.deployment.resources.apiWorker,
      result.manifest.deployment.resources.proxyWorker,
      result.manifest.deployment.resources.tailWorker,
      result.manifest.deployment.resources.dispatchWorker,
    ]);
    expect(deployedTrafficStates).toEqual([
      'staging',
      'staging',
      undefined,
      'staging',
      'enabled',
      'enabled',
      undefined,
      'enabled',
    ]);
    expect(apiSecrets).toMatchObject({ PLATFORM_BOOTSTRAP_GITHUB_ID: '583231' });
    expect(JSON.parse(r2OwnershipMarker)).toMatchObject({
      accountId: 'account',
      installationId: result.manifest.id,
      ownershipNonce: result.manifest.ownershipNonce,
      resourceKey: 'assets-bucket',
    });
    expect(JSON.parse(remoteManifest)).toMatchObject({
      id: result.manifest.id,
      status: 'installed',
    });
    expect(routingValues.get('signup:enabled')).toBe('true');
    expect(JSON.parse(routingValues.get('signup:allowlist')!)).toEqual([]);
    expect(routingValues.has(PLATFORM_DISABLED_KEY)).toBe(false);
    expect(lifecycleEvents[0]).toBe(`put:${PLATFORM_DISABLED_KEY}`);
    expect(lifecycleEvents.filter((event) => event === 'verify')).toHaveLength(2);
    expect(lifecycleEvents.indexOf('verify')).toBeLessThan(
      lifecycleEvents.lastIndexOf(`deploy:${result.manifest.deployment.resources.dispatchWorker}`),
    );
    expect(lifecycleEvents.indexOf(`delete:${PLATFORM_DISABLED_KEY}`)).toBeLessThan(
      lifecycleEvents.lastIndexOf('verify'),
    );
    expect(listInstallationManifests(directory)).toHaveLength(1);
    expect(readdirSync(join(directory, 'account')).some((name) => name.endsWith('.secrets'))).toBe(
      false,
    );
  });

  it('closes the routing gate before an ambiguous fresh Worker upload', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-platform-worker-ambiguity-test-'));
    directories.push(directory);
    process.env.VOID_PLATFORM_REGISTRY_DIR = directory;
    const plan = await createPlatformInstallPlan(
      planningClient(),
      {
        accountId: 'account',
        applicationDomain: 'apps.example.com',
        controlPlaneDomain: '',
        dedicatedZone: false,
        displayName: 'Example',
        installationSlug: 'example',
        zoneName: 'example.com',
      },
      null,
    );
    let index = 0;
    let disabled = false;
    const create = async (_account: string, name: string) => ({ id: `id-${index++}`, name });

    await expect(
      installPlatform(
        plan,
        createPlatformInstallationSecrets({
          bootstrapGitHubId: '583231',
          bootstrapGitHubLogin: 'octocat',
          cloudflareApiToken: 'cf-token',
          databaseUrl: 'postgres://user:password@db.example.com/void',
          githubClientId: 'github-id',
          githubClientSecret: 'github-secret',
          r2AccessKeyId: 'r2-id',
          r2SecretAccessKey: 'r2-secret',
        }),
        null,
        {
          acquireDatabaseLifecycleLock,
          claimDatabase,
          client: {
            createAiGateway: create,
            createDispatchNamespace: create,
            createDnsRecord: async (_zone, name) => ({
              content: '100::',
              id: `id-${index++}`,
              name,
              proxied: true,
              type: 'AAAA',
            }),
            createHyperdrive: async (account, name) => create(account, name),
            createKvNamespace: create,
            createQueue: create,
            createR2Bucket: create,
            createZone: async () => {
              throw new Error('existing zone must not be created');
            },
            putKvValue: async (_account, _namespace, key, value) => {
              if (key === PLATFORM_DISABLED_KEY) {
                expect(value).toBe(PLATFORM_DISABLED_VALUE);
                disabled = true;
              }
            },
            putR2Object: async () => {},
          },
          deployWorker: async () => {
            expect(disabled).toBe(true);
            throw new Error('Worker upload response was lost');
          },
          migrateDatabase: async () => {},
          revalidateBeforeWorkerDeploy: async () => {},
        },
      ),
    ).rejects.toThrow('Worker upload response was lost');

    expect(disabled).toBe(true);
    expect(listInstallationManifests(directory)[0]).toMatchObject({ status: 'failed' });
  });

  it('keeps a cutover unresolved when the current Worker rollback is incomplete', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-platform-incomplete-rollback-test-'));
    directories.push(directory);
    process.env.VOID_PLATFORM_REGISTRY_DIR = directory;
    const plan = await createPlatformInstallPlan(
      planningClient(),
      {
        accountId: 'account',
        applicationDomain: 'apps.example.com',
        controlPlaneDomain: '',
        dedicatedZone: false,
        displayName: 'Example',
        installationSlug: 'example',
        zoneName: 'example.com',
      },
      null,
    );
    let index = 0;
    let deployments = 0;
    let previousRollbackRan = false;
    const create = async (_account: string, name: string) => ({ id: `id-${index++}`, name });

    await expect(
      installPlatform(
        plan,
        createPlatformInstallationSecrets({
          bootstrapGitHubId: '583231',
          bootstrapGitHubLogin: 'octocat',
          cloudflareApiToken: 'cf-token',
          databaseUrl: 'postgres://user:password@db.example.com/void',
          githubClientId: 'github-id',
          githubClientSecret: 'github-secret',
          r2AccessKeyId: 'r2-id',
          r2SecretAccessKey: 'r2-secret',
        }),
        null,
        {
          acquireDatabaseLifecycleLock,
          claimDatabase,
          client: {
            createAiGateway: create,
            createDispatchNamespace: create,
            createDnsRecord: async (_zone, name) => ({
              content: '100::',
              id: `id-${index++}`,
              name,
              proxied: true,
              type: 'AAAA',
            }),
            createHyperdrive: async (account, name) => create(account, name),
            createKvNamespace: create,
            createQueue: create,
            createR2Bucket: create,
            createZone: async () => {
              throw new Error('existing zone must not be created');
            },
            putKvValue: async () => {},
            putR2Object: async () => {},
          },
          deployWorker: async () => {
            deployments++;
            if (deployments === 1) {
              return async () => {
                previousRollbackRan = true;
              };
            }
            throw new PlatformWorkerRecoveryIncompleteError(
              'platform: Automatic recovery for proxy was incomplete.',
            );
          },
          migrateDatabase: async () => {},
          revalidateBeforeWorkerDeploy: async () => {},
        },
      ),
    ).rejects.toThrow('cutover remains unresolved');

    const failed = listInstallationManifests(directory)[0]!;
    expect(previousRollbackRan).toBe(true);
    expect(
      failed.steps.some(
        (step) => step.key.startsWith('worker-cutover:') && step.resultHash === 'restored',
      ),
    ).toBe(false);
    expect(failed.status).toBe('failed');
  });

  it('retains an ambiguous resource before recording its replacement', async () => {
    const plan = await createPlatformInstallPlan(
      planningClient(),
      {
        accountId: 'account',
        applicationDomain: 'apps.example.com',
        controlPlaneDomain: '',
        dedicatedZone: false,
        displayName: 'Example',
        installationSlug: 'example',
        zoneName: 'example.com',
      },
      null,
    );
    const fingerprint = '2026-09-14T00:00:00.000Z';
    let manifest = createPlatformInstallationManifest({
      account: plan.account,
      createdAt: '2026-09-14T00:00:00.000Z',
      deployment: plan.deployment,
      id: plan.installationId,
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '0.10.14',
    });
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: r2BucketConfigHash(plan.deployment.resources.assetsBucket, fingerprint),
        id: plan.deployment.resources.assetsBucket,
        key: 'assets-bucket',
        kind: 'r2-bucket',
        name: plan.deployment.resources.assetsBucket,
        ownership: 'created',
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
    const replacement = {
      action: 'create' as const,
      id: null,
      key: 'assets-bucket',
      kind: 'r2-bucket' as const,
      name: `${plan.deployment.resources.assetsBucket}-replacement`,
      reason: 'Replace ambiguous bucket.',
    };
    const retained = retainReplacedInstallationResource(
      manifest,
      replacement,
      '2026-09-14T00:00:02.000Z',
    );
    expect(retained.resources).not.toContainEqual(
      expect.objectContaining({ key: 'assets-bucket' }),
    );
    expect(retained.resources).toContainEqual(
      expect.objectContaining({
        id: plan.deployment.resources.assetsBucket,
        kind: 'r2-bucket',
        state: 'retained',
      }),
    );
  });

  it('stops after a newly-created zone until nameservers become active', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-platform-installer-dns-test-'));
    directories.push(directory);
    process.env.VOID_PLATFORM_REGISTRY_DIR = directory;
    const plan = await createPlatformInstallPlan(
      { ...planningClient(), findZone: async () => null },
      {
        accountId: 'account',
        applicationDomain: 'example.net',
        controlPlaneDomain: '',
        dedicatedZone: true,
        displayName: 'Example',
        installationSlug: 'example',
        zoneName: 'example.net',
      },
      null,
    );
    const result = await installPlatform(
      plan,
      createPlatformInstallationSecrets({
        bootstrapGitHubId: '583231',
        bootstrapGitHubLogin: 'octocat',
        cloudflareApiToken: 'cf-token',
        databaseUrl: 'postgres://user:password@db.example.com/void',
        githubClientId: 'github-id',
        githubClientSecret: 'github-secret',
        r2AccessKeyId: 'r2-id',
        r2SecretAccessKey: 'r2-secret',
      }),
      null,
      {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: {
          createAiGateway: async () => {
            throw new Error('must wait for DNS');
          },
          createZone: async () => ({
            id: 'new-zone',
            name: 'example.net',
            nameServers: ['a.ns.cloudflare.com', 'b.ns.cloudflare.com'],
            status: 'pending',
          }),
          createDnsRecord: async () => {
            throw new Error('must wait for DNS');
          },
          createKvNamespace: async () => {
            return { id: 'routing-kv-id', name: plan.deployment.resources.routingKv };
          },
          createR2Bucket: async () => {
            throw new Error('must wait for DNS');
          },
          createQueue: async () => {
            throw new Error('must wait for DNS');
          },
          createDispatchNamespace: async () => {
            throw new Error('must wait for DNS');
          },
          createHyperdrive: async () => {
            throw new Error('must wait for DNS');
          },
          putKvValue: async () => {
            // The remote recovery checkpoint is established before waiting.
          },
          putR2Object: async () => {
            throw new Error('must wait for DNS');
          },
        },
        revalidateBeforeWorkerDeploy: async () => {},
      },
    );
    expect(result.waitingForDns).toBe(true);
    expect(result.manifest.status).toBe('waiting-for-dns');
    expect(result.manifest.resources.map((resource) => resource.key).sort()).toEqual([
      'routing-kv',
      'zone',
    ]);
  });

  it('redeploys every Worker while reusing provisioned resources on upgrade', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-platform-upgrade-test-'));
    directories.push(directory);
    process.env.VOID_PLATFORM_REGISTRY_DIR = directory;
    const initialPlan = await createPlatformInstallPlan(
      planningClient(),
      {
        accountId: 'account',
        applicationDomain: 'apps.example.com',
        controlPlaneDomain: '',
        dedicatedZone: false,
        displayName: 'Example',
        installationSlug: 'example',
        zoneName: 'example.com',
      },
      null,
    );
    let index = 0;
    const create = async (_account: string, name: string) => ({ id: `id-${index++}`, name });
    const secrets = createPlatformInstallationSecrets({
      bootstrapGitHubId: '583231',
      bootstrapGitHubLogin: 'octocat',
      cloudflareApiToken: 'cf-token',
      databaseUrl: 'postgres://user:password@db.example.com/void',
      githubClientId: 'github-id',
      githubClientSecret: 'github-secret',
      r2AccessKeyId: 'r2-id',
      r2SecretAccessKey: 'r2-secret',
    });
    const installed = await installPlatform(initialPlan, secrets, null, {
      acquireDatabaseLifecycleLock,
      claimDatabase,
      client: {
        createAiGateway: async (_account, name) => ({ id: name, name }),
        createDnsRecord: async (_zone, name) => ({
          content: '100::',
          id: `id-${index++}`,
          name,
          proxied: true,
          type: 'AAAA',
        }),
        createZone: async () => {
          throw new Error('existing zone must not be created');
        },
        createKvNamespace: create,
        createR2Bucket: create,
        createQueue: create,
        createDispatchNamespace: create,
        createHyperdrive: async (account, name) => create(account, name),
        deleteKvValue: async () => {},
        putKvValue: async () => {},
        putR2Object: async () => {},
      },
      deployWorker: async () => {},
      migrateDatabase: async () => {},
      revalidateBeforeWorkerDeploy: async () => {},
      verifyHealth: async () => {},
    });
    const byKey = new Map(installed.manifest.resources.map((resource) => [resource.key, resource]));
    expect(byKey.get('hyperdrive')?.configHash).toBe(
      hyperdriveOriginConfigHash(hyperdriveOriginFromConnectionString(secrets.databaseUrl)),
    );
    const deployment = installed.manifest.deployment;
    const assetsBucket = installed.manifest.resources.find(
      (resource) => resource.key === 'assets-bucket',
    )!;
    const upgradedPlan = await createPlatformInstallPlan(
      {
        ...planningClient(),
        getR2Object: async () =>
          JSON.stringify(
            createPlatformResourceOwnershipMarker({
              accountId: installed.manifest.account.id,
              installationId: installed.manifest.id,
              ownershipNonce: installed.manifest.ownershipNonce,
              resourceId: assetsBucket.id,
              resourceKey: assetsBucket.key,
              resourceKind: assetsBucket.kind,
              resourceName: assetsBucket.name,
            }),
          ),
        listAiGateways: async () => [named('ai-gateway')],
        listDnsRecords: async () => [
          {
            ...named('application-dns'),
            content: '100::',
            proxied: true,
            type: 'AAAA',
          },
        ],
        listKvNamespaces: async (_account: string, title?: string) => {
          const match = installed.manifest.resources.find(
            (resource) => resource.kind === 'kv-namespace' && resource.name === title,
          );
          return match ? [{ id: match.id, name: match.name }] : [];
        },
        listR2Buckets: async () => [
          { ...named('assets-bucket'), fingerprint: '2026-09-14T00:00:00.000Z' },
        ],
        listQueues: async (_account: string, name: string) => {
          const match = installed.manifest.resources.find(
            (resource) => resource.kind === 'queue' && resource.name === name,
          );
          return match ? [{ id: match.id, name: match.name }] : [];
        },
        listDispatchNamespaces: async () => [named('dispatch-namespace')],
        listHyperdriveConfigs: async () => [named('hyperdrive')],
        listWorkerNames: async () => [
          deployment.resources.apiWorker,
          deployment.resources.proxyWorker,
          deployment.resources.tailWorker,
          deployment.resources.dispatchWorker,
        ],
      },
      {
        accountId: 'account',
        applicationDomain: deployment.application.baseDomain,
        controlPlaneDomain: '',
        dedicatedZone: false,
        displayName: deployment.displayName,
        installationSlug: deployment.installationSlug,
        zoneName: deployment.application.zoneName,
      },
      installed.manifest,
    );
    const deployed: Array<string> = [];
    let migrations = 0;
    const upgradeKvWrites: Array<string> = [];
    const deletedKvValues: Array<string> = [];
    const upgradeClient = {
      createAiGateway: create,
      createDnsRecord: async (_zone: string, name: string) => ({
        content: '100::',
        id: name,
        name,
        proxied: true,
        type: 'AAAA' as const,
      }),
      createZone: async () => {
        throw new Error('must reuse zone');
      },
      createKvNamespace: create,
      createR2Bucket: create,
      createQueue: create,
      createDispatchNamespace: create,
      createHyperdrive: async (account: string, name: string) => create(account, name),
      deleteKvValue: async (_account: string, _namespace: string, key: string) => {
        deletedKvValues.push(key);
      },
      putKvValue: async (_account: string, _namespace: string, key: string) => {
        upgradeKvWrites.push(key);
      },
      putR2Object: async () => {},
    };
    const sourceManifest = { ...installed.manifest, platformVersion: '0.10.13' };
    let verifiedTargetVersion = '';
    await expect(
      installPlatform(upgradedPlan, secrets, sourceManifest, {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: upgradeClient,
        deployWorker: async () => async () => {},
        migrateDatabase: async () => {},
        revalidateBeforeWorkerDeploy: async () => {},
        verifyHealth: async (_api, _id, _proxy, _domain, platformVersion) => {
          verifiedTargetVersion = platformVersion;
          throw new Error('upgrade health failed');
        },
      }),
    ).rejects.toThrow('upgrade health failed');
    expect(verifiedTargetVersion).toBe(readPlatformRuntimeManifest().platformVersion);
    expect(listInstallationManifests(directory)[0]?.platformVersion).toBe('0.10.13');

    const upgraded = await installPlatform(upgradedPlan, secrets, sourceManifest, {
      acquireDatabaseLifecycleLock,
      claimDatabase,
      client: upgradeClient,
      deployWorker: async (config) => {
        deployed.push(String(config.name));
      },
      migrateDatabase: async () => {
        migrations++;
      },
      revalidateBeforeWorkerDeploy: async () => {},
      verifyHealth: async () => {},
    });

    expect(deployed).toEqual([
      deployment.resources.apiWorker,
      deployment.resources.proxyWorker,
      deployment.resources.tailWorker,
      deployment.resources.dispatchWorker,
    ]);
    expect(migrations).toBe(0);
    expect(new Set(upgradeKvWrites)).toEqual(new Set(['__void/platform/installation/v1']));
    expect(upgraded.manifest.status).toBe('installed');
    expect(upgraded.manifest.platformVersion).toBe(readPlatformRuntimeManifest().platformVersion);
    expect(upgraded.manifest.resources).toHaveLength(15);

    const disabledConfigs: Array<Record<string, unknown>> = [];
    let disabledHealthChecks = 0;
    const disabledUpgrade = await installPlatform(
      upgradedPlan,
      secrets,
      {
        ...setInstallationDesiredState(upgraded.manifest, 'disabled', '2026-09-14T00:00:04.000Z'),
        status: 'disabled',
      },
      {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: upgradeClient,
        deployWorker: async (config) => {
          disabledConfigs.push(config);
        },
        migrateDatabase: async () => {
          migrations++;
        },
        revalidateBeforeWorkerDeploy: async () => {},
        verifyHealth: async () => {
          disabledHealthChecks++;
        },
      },
    );
    expect(disabledUpgrade.manifest.status).toBe('disabled');
    expect(disabledHealthChecks).toBe(0);
    expect(disabledConfigs).toHaveLength(4);
    for (const config of disabledConfigs) {
      expect(config.workers_dev).toBe(false);
      expect(config.preview_urls).toBe(false);
      expect(config).not.toHaveProperty('routes');
    }

    let interrupted = false;
    await expect(
      installPlatform(upgradedPlan, secrets, disabledUpgrade.manifest, {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: upgradeClient,
        deployWorker: async () => {
          interrupted = true;
          throw new Error('interrupted deployment');
        },
        migrateDatabase: async () => {},
        revalidateBeforeWorkerDeploy: async () => {},
      }),
    ).rejects.toThrow('interrupted deployment');
    expect(interrupted).toBe(true);
    const failedDisabledUpgrade = listInstallationManifests(directory)[0]!;
    expect(failedDisabledUpgrade.status).toBe('failed');
    expect(failedDisabledUpgrade.desiredState).toBe('disabled');

    const resumedConfigs: Array<Record<string, unknown>> = [];
    const resumedDisabledUpgrade = await installPlatform(
      upgradedPlan,
      secrets,
      failedDisabledUpgrade,
      {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: upgradeClient,
        deployWorker: async (config) => {
          resumedConfigs.push(config);
        },
        migrateDatabase: async () => {},
        revalidateBeforeWorkerDeploy: async () => {},
      },
    );
    expect(resumedDisabledUpgrade.manifest.status).toBe('disabled');
    expect(resumedConfigs).toHaveLength(4);
    for (const config of resumedConfigs) {
      expect(config.workers_dev).toBe(false);
      expect(config.preview_urls).toBe(false);
      expect(config).not.toHaveProperty('routes');
    }

    const concurrentEnableEvents: Array<string> = [];
    let cutoverVerifications = 0;
    await expect(
      installPlatform(
        upgradedPlan,
        secrets,
        setInstallationDesiredState(
          resumedDisabledUpgrade.manifest,
          'enabled',
          '2026-09-14T00:00:04.250Z',
        ),
        {
          acquireDatabaseLifecycleLock,
          claimDatabase,
          client: {
            ...upgradeClient,
            deleteKvValue: async (_account, _namespace, key) => {
              concurrentEnableEvents.push(`delete:${key}`);
            },
            putKvValue: async (_account, _namespace, key) => {
              if (key === PLATFORM_DISABLED_KEY) {
                concurrentEnableEvents.push(`put:${key}`);
              }
            },
          },
          deployWorker: async () => async () => {},
          migrateDatabase: async () => {},
          revalidateBeforeWorkerDeploy: async () => {},
          verifyHealth: async () => {},
          verifyWorkerCutover: async () => {
            cutoverVerifications++;
            if (cutoverVerifications === 2) {
              throw new Error('platform: API Worker changed concurrently.');
            }
          },
        },
      ),
    ).rejects.toThrow('API Worker changed concurrently');
    expect(cutoverVerifications).toBe(2);
    expect(concurrentEnableEvents.slice(-2)).toEqual([
      `delete:${PLATFORM_DISABLED_KEY}`,
      `put:${PLATFORM_DISABLED_KEY}`,
    ]);

    const failedEnableEvents: Array<string> = [];
    let failedEnableDeploys = 0;
    await expect(
      installPlatform(
        upgradedPlan,
        secrets,
        setInstallationDesiredState(
          resumedDisabledUpgrade.manifest,
          'enabled',
          '2026-09-14T00:00:04.500Z',
        ),
        {
          acquireDatabaseLifecycleLock,
          claimDatabase,
          client: upgradeClient,
          deployWorker: async (config) => {
            const deploymentIndex = ++failedEnableDeploys;
            failedEnableEvents.push(`deploy:${deploymentIndex}:${String(config.name)}`);
            if (deploymentIndex === 6) {
              throw new Error('generation 2 deployment failed');
            }
            return async () => {
              failedEnableEvents.push(`rollback:${deploymentIndex}:${String(config.name)}`);
              if (deploymentIndex === 5) {
                throw new Error('generation 2 rollback failed');
              }
            };
          },
          migrateDatabase: async () => {},
          revalidateBeforeWorkerDeploy: async () => {},
          verifyHealth: async () => {},
        },
      ),
    ).rejects.toThrow(
      'generation 2 deployment failed Automatic Worker rollback was incomplete: generation 2 rollback failed',
    );
    expect(failedEnableEvents.filter((event) => event.startsWith('rollback:'))).toEqual([
      `rollback:5:${deployment.resources.apiWorker}`,
    ]);

    const failedEnableManifest = listInstallationManifests(directory)[0]!;
    const retryPreviousConfigs: Array<Record<string, unknown>> = [];
    const retriedEnable = await installPlatform(upgradedPlan, secrets, failedEnableManifest, {
      acquireDatabaseLifecycleLock,
      claimDatabase,
      client: upgradeClient,
      deployWorker: async (_config, _secrets, previousConfig) => {
        retryPreviousConfigs.push(previousConfig);
      },
      migrateDatabase: async () => {},
      revalidateBeforeWorkerDeploy: async () => {},
      verifyHealth: async () => {},
    });
    expect(retriedEnable.manifest.status).toBe('installed');
    expect(retryPreviousConfigs).toHaveLength(8);
    expect(retryPreviousConfigs.slice(0, 4).every((config) => config.workers_dev === false)).toBe(
      true,
    );
    expect(retryPreviousConfigs.slice(4).every((config) => config.workers_dev === true)).toBe(true);
    expect(
      retryPreviousConfigs
        .slice(4)
        .filter((config) => !String(config.name).endsWith('-tail'))
        .every(
          (config) => (config.vars as Record<string, unknown>).PLATFORM_TRAFFIC_STATE === 'staging',
        ),
    ).toBe(true);

    const enabledConfigs: Array<Record<string, unknown>> = [];
    let enabledHealthChecks = 0;
    const enabledUpgrade = await installPlatform(
      upgradedPlan,
      secrets,
      setInstallationDesiredState(
        resumedDisabledUpgrade.manifest,
        'enabled',
        '2026-09-14T00:00:05.000Z',
      ),
      {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: upgradeClient,
        deployWorker: async (config) => {
          enabledConfigs.push(config);
        },
        migrateDatabase: async () => {},
        revalidateBeforeWorkerDeploy: async () => {},
        verifyHealth: async () => {
          enabledHealthChecks++;
        },
      },
    );
    expect(enabledUpgrade.manifest.status).toBe('installed');
    expect(enabledUpgrade.manifest.desiredState).toBe('enabled');
    expect(enabledHealthChecks).toBe(2);
    expect(deletedKvValues).toContain('__void/platform/disabled/v1');
    expect(enabledConfigs).toHaveLength(8);
    for (const config of enabledConfigs.slice(0, 4)) {
      expect((config.vars as Record<string, unknown>).PLATFORM_TRAFFIC_STATE).not.toBe('enabled');
    }
    for (const config of enabledConfigs.slice(4)) {
      expect(config.workers_dev).toBe(true);
      expect(config.preview_urls).toBe(true);
      if (!String(config.name).endsWith('-tail')) {
        expect((config.vars as Record<string, unknown>).PLATFORM_TRAFFIC_STATE).toBe('enabled');
      }
    }
    expect(
      enabledConfigs.slice(4).find((config) => config.name === deployment.resources.dispatchWorker),
    ).toHaveProperty('routes');

    const disabledRollbackStates: Array<unknown> = [];
    let disabledRollbackDeploys = 0;
    await expect(
      installPlatform(
        upgradedPlan,
        secrets,
        {
          ...setInstallationDesiredState(
            enabledUpgrade.manifest,
            'disabled',
            '2026-09-14T00:00:05.500Z',
          ),
          status: 'disabled',
        },
        {
          acquireDatabaseLifecycleLock,
          claimDatabase,
          client: upgradeClient,
          deployWorker: async (_config, _secrets, previousConfig) => {
            disabledRollbackStates.push(previousConfig.workers_dev);
            disabledRollbackDeploys++;
            if (disabledRollbackDeploys === 2) {
              throw new Error('disabled upgrade failed');
            }
            return async () => {};
          },
          migrateDatabase: async () => {},
          revalidateBeforeWorkerDeploy: async () => {},
        },
      ),
    ).rejects.toThrow('disabled upgrade failed');
    expect(disabledRollbackStates).toEqual([false, false]);

    let replacedWorkerDeploys = 0;
    await expect(
      installPlatform(upgradedPlan, secrets, enabledUpgrade.manifest, {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: upgradeClient,
        deployWorker: async () => {
          replacedWorkerDeploys++;
        },
        migrateDatabase: async () => {},
        revalidateBeforeWorkerDeploy: async () => {
          throw new Error('platform: Worker ownership marker changed after planning.');
        },
      }),
    ).rejects.toThrow('ownership marker changed after planning');
    expect(replacedWorkerDeploys).toBe(0);

    const partialEvents: Array<string> = [];
    let partialDeploys = 0;
    await expect(
      installPlatform(upgradedPlan, secrets, enabledUpgrade.manifest, {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: upgradeClient,
        deployWorker: async (config) => {
          const name = String(config.name);
          partialDeploys++;
          partialEvents.push(`deploy:${name}`);
          if (partialDeploys === 3) {
            throw new Error('third Worker failed');
          }
          return async () => {
            partialEvents.push(`rollback:${name}`);
          };
        },
        migrateDatabase: async () => {},
        revalidateBeforeWorkerDeploy: async () => {},
      }),
    ).rejects.toThrow('third Worker failed');
    expect(partialEvents).toEqual([
      `deploy:${deployment.resources.apiWorker}`,
      `deploy:${deployment.resources.proxyWorker}`,
      `deploy:${deployment.resources.tailWorker}`,
      `rollback:${deployment.resources.proxyWorker}`,
      `rollback:${deployment.resources.apiWorker}`,
    ]);

    const healthEvents: Array<string> = [];
    await expect(
      installPlatform(upgradedPlan, secrets, enabledUpgrade.manifest, {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: upgradeClient,
        deployWorker: async (config) => {
          const name = String(config.name);
          healthEvents.push(`deploy:${name}`);
          return async () => {
            healthEvents.push(`rollback:${name}`);
          };
        },
        migrateDatabase: async () => {},
        revalidateBeforeWorkerDeploy: async () => {},
        verifyHealth: async () => {
          throw new Error('health check failed');
        },
      }),
    ).rejects.toThrow('health check failed');
    expect(healthEvents.slice(-4)).toEqual([
      `rollback:${deployment.resources.dispatchWorker}`,
      `rollback:${deployment.resources.tailWorker}`,
      `rollback:${deployment.resources.proxyWorker}`,
      `rollback:${deployment.resources.apiWorker}`,
    ]);

    let rollbackIndex = 0;
    await expect(
      installPlatform(upgradedPlan, secrets, enabledUpgrade.manifest, {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: upgradeClient,
        deployWorker: async () => async () => {
          rollbackIndex++;
          if (rollbackIndex === 2) {
            throw new Error('rollback unavailable');
          }
        },
        migrateDatabase: async () => {},
        revalidateBeforeWorkerDeploy: async () => {},
        verifyHealth: async () => {
          throw new Error('health check failed');
        },
      }),
    ).rejects.toThrow(
      'health check failed Automatic Worker rollback was incomplete: rollback unavailable',
    );
    expect(rollbackIndex).toBe(4);

    const interruptedCutover = {
      ...enabledUpgrade.manifest,
      status: 'failed' as const,
      steps: [
        ...enabledUpgrade.manifest.steps,
        {
          completedAt: '2026-09-14T00:00:06.000Z',
          key: 'worker-cutover:999:staged:api',
          resultHash: cutoverSnapshot(deployment.resources.apiWorker, 'previous-api', 'staged-api'),
        },
        {
          completedAt: '2026-09-14T00:00:06.000Z',
          key: 'worker-cutover:999:staged:proxy',
          resultHash: cutoverSnapshot(
            deployment.resources.proxyWorker,
            'previous-proxy',
            'staged-proxy',
          ),
        },
        {
          completedAt: '2026-09-14T00:00:06.000Z',
          key: 'worker-cutover:999:unsafe-traffic:proxy',
          resultHash: deployment.resources.proxyWorker,
        },
      ],
    };
    const recoveryEvents: Array<string> = [];
    const recovered = await installPlatform(upgradedPlan, secrets, interruptedCutover, {
      acquireDatabaseLifecycleLock,
      claimDatabase,
      client: {
        ...upgradeClient,
        deleteKvValue: async (_account, _namespace, key) => {
          recoveryEvents.push(`delete:${key}`);
        },
        putKvValue: async (_account, _namespace, key) => {
          if (key === PLATFORM_DISABLED_KEY) {
            recoveryEvents.push(`put:${key}`);
          }
        },
      },
      deployWorker: async (config) => {
        recoveryEvents.push(`deploy:${String(config.name)}`);
      },
      migrateDatabase: async () => {},
      recoverWorkerCutover: async (snapshot) => {
        recoveryEvents.push(
          `recover:${snapshot.key}:${snapshot.previousVersionId}:${snapshot.stagedVersionId}:${snapshot.preserveCustomDomains}`,
        );
      },
      revalidateBeforeWorkerDeploy: async () => {},
      verifyHealth: async () => {},
      verifyWorkerCutover: async () => {
        recoveryEvents.push('verify-cutover');
      },
    });
    expect(recoveryEvents.slice(0, 3)).toEqual([
      `put:${PLATFORM_DISABLED_KEY}`,
      'recover:proxy:previous-proxy:staged-proxy:true',
      'recover:api:previous-api:staged-api:false',
    ]);
    expect(recoveryEvents.filter((event) => event === 'verify-cutover')).toHaveLength(2);
    expect(recoveryEvents.indexOf('verify-cutover')).toBeLessThan(
      recoveryEvents.indexOf(`delete:${PLATFORM_DISABLED_KEY}`),
    );
    expect(recovered.manifest.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'worker-cutover:999:restored' }),
        expect.objectContaining({ key: 'worker-traffic-state:999', resultHash: 'disabled' }),
        expect.objectContaining({ key: 'worker-cutover:1000:committed' }),
      ]),
    );

    const interruptedInitialCutover = {
      ...enabledUpgrade.manifest,
      status: 'failed' as const,
      steps: [
        ...enabledUpgrade.manifest.steps,
        {
          completedAt: '2026-09-14T00:00:07.000Z',
          key: 'worker-cutover:2000:staged:api',
          resultHash: cutoverSnapshot(deployment.resources.apiWorker, null, 'staged-api'),
        },
      ],
    };
    let replannedResourceState = '';
    const replannedActions: Array<string> = [];
    await installPlatform(upgradedPlan, secrets, interruptedInitialCutover, {
      acquireDatabaseLifecycleLock,
      claimDatabase,
      client: upgradeClient,
      deployWorker: async () => {},
      migrateDatabase: async () => {},
      recoverWorkerCutover: async () => {},
      replanWorkers: async (manifest) => {
        replannedResourceState = manifest.resources.find(
          (resource) => resource.key === 'api-worker',
        )!.state;
        return upgradedPlan.actions
          .filter((action) => action.kind === 'worker')
          .map((action) =>
            action.key === 'api-worker' ? { ...action, action: 'reuse', id: action.name } : action,
          );
      },
      revalidateBeforeWorkerDeploy: async (_manifest, action) => {
        replannedActions.push(`${action.key}:${action.action}`);
      },
      verifyHealth: async () => {},
    });
    expect(replannedResourceState).toBe('ready');
    expect(replannedActions).toContain('api-worker:reuse');

    function named(key: string) {
      const resource = byKey.get(key)!;
      return { id: resource.id, name: resource.name };
    }

    function cutoverSnapshot(
      workerName: string,
      previousVersionId: string | null,
      stagedVersionId: string,
    ) {
      return Buffer.from(
        JSON.stringify({
          previousTriggers: {
            crons: [],
            preview_urls: true,
            queueConsumers: [],
            routes: [],
            workers_dev: true,
            workflows: [],
          },
          previousVersionId,
          schema: 1,
          stagedVersionId,
          workerName,
        }),
      ).toString('base64url');
    }
  });
});

function migrationSubset(length: number): PlatformRuntimeDatabaseManifest {
  const database = readPlatformRuntimeManifest().database;
  const migrations = database.migrations.slice(0, length);
  return {
    ...database,
    migrations,
    rollbackSafeFrom: [],
    schemaDigest: platformDatabaseSchemaDigest(database.lineage, migrations),
  };
}

function migrationConnection(
  initialRows: Array<{ created_at: unknown; hash: unknown; id: unknown }> = [],
  failSql = '',
) {
  let relationExists = initialRows.length > 0;
  let transactionRows: Array<{ created_at: unknown; hash: unknown; id: unknown }> | null = null;
  let transactionRelation = false;
  const rows = [...initialRows];
  const queries: Array<string> = [];
  const result = <Row extends Record<string, unknown>>(value: ReadonlyArray<unknown>) => ({
    rows: value as ReadonlyArray<Row>,
  });
  return {
    queries,
    rows,
    query: async <Row extends Record<string, unknown>>(
      sql: string,
      values?: ReadonlyArray<unknown>,
    ) => {
      queries.push(sql.trim());
      if (sql === 'BEGIN') {
        transactionRows = rows.map((row) => ({ ...row }));
        transactionRelation = relationExists;
      } else if (sql === 'ROLLBACK') {
        rows.splice(0, rows.length, ...(transactionRows ?? []));
        relationExists = transactionRelation;
        transactionRows = null;
      } else if (sql === 'COMMIT') {
        transactionRows = null;
      } else if (sql.includes('to_regclass')) {
        return result<Row>([{ relation: relationExists ? 'drizzle.__drizzle_migrations' : null }]);
      } else if (sql.includes('FROM "drizzle"."__drizzle_migrations"')) {
        return result<Row>(
          [...rows].sort(
            (left, right) =>
              Number(left.created_at) - Number(right.created_at) ||
              Number(left.id) - Number(right.id),
          ),
        );
      } else if (sql.includes('CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations"')) {
        relationExists = true;
      } else if (sql.includes('INSERT INTO "drizzle"."__drizzle_migrations"')) {
        rows.push({ created_at: values?.[1], hash: values?.[0], id: rows.length + 1 });
      } else if (failSql && sql.includes(failSql)) {
        throw new Error('migration failed');
      }
      return result<Row>([]);
    },
  };
}
