import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  recordInstallationResource,
  recordInstallationStep,
  setInstallationDesiredState,
  transitionInstallation,
} from '@void/platform';
import { join } from 'pathslash';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  acquirePlatformDatabaseLifecycleLockConnection,
  installPlatform,
  claimPlatformDatabaseConnection,
  createPlatformInstallationSecrets,
  readPlatformDatabaseLifecycleManifestConnection,
  resolveBootstrapGitHubId,
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

describe('platform installer', () => {
  const claimDatabase = async () => {};
  const acquireDatabaseLifecycleLock = async () => async () => {};

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
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/^SELECT/);
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
    let apiSecrets: Record<string, string> | null = null;
    let r2OwnershipMarker = '';
    const routingValues = new Map<string, string>();
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
          putKvValue: async (_account, _namespace, key, value) => {
            routingValues.set(key, value);
            if (key === '__void/platform/installation/v1') {
              remoteManifest = value;
            }
          },
          putR2Object: async (_account, _bucket, _key, value) => {
            r2OwnershipMarker = value;
          },
        },
        deployWorker: async (config, secrets) => {
          deployed.push(String(config.name));
          if (String(config.name).endsWith('-api')) {
            apiSecrets = secrets;
          }
        },
        migrateDatabase: async () => {},
        revalidateBeforeWorkerDeploy: async () => {},
        verifyHealth: async () => {},
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
    expect(listInstallationManifests(directory)).toHaveLength(1);
    expect(readdirSync(join(directory, 'account')).some((name) => name.endsWith('.secrets'))).toBe(
      false,
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
        putKvValue: async () => {},
        putR2Object: async () => {},
      },
      deployWorker: async () => {},
      migrateDatabase: async () => {},
      revalidateBeforeWorkerDeploy: async () => {},
      verifyHealth: async () => {},
    });
    const byKey = new Map(installed.manifest.resources.map((resource) => [resource.key, resource]));
    const deployment = installed.manifest.deployment;
    const upgradedPlan = await createPlatformInstallPlan(
      {
        ...planningClient(),
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
        listR2Buckets: async () => [named('assets-bucket')],
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
      putKvValue: async (_account: string, _namespace: string, key: string) => {
        upgradeKvWrites.push(key);
      },
      putR2Object: async () => {},
    };
    const upgraded = await installPlatform(upgradedPlan, secrets, installed.manifest, {
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
    expect(enabledHealthChecks).toBe(1);
    expect(enabledConfigs).toHaveLength(4);
    for (const config of enabledConfigs) {
      expect(config.workers_dev).toBe(true);
      expect(config.preview_urls).toBe(true);
    }
    expect(
      enabledConfigs.find((config) => config.name === deployment.resources.dispatchWorker),
    ).toHaveProperty('routes');

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
      ],
    };
    const recoveryEvents: Array<string> = [];
    const recovered = await installPlatform(upgradedPlan, secrets, interruptedCutover, {
      acquireDatabaseLifecycleLock,
      claimDatabase,
      client: upgradeClient,
      deployWorker: async (config) => {
        recoveryEvents.push(`deploy:${String(config.name)}`);
      },
      migrateDatabase: async () => {},
      recoverWorkerCutover: async (snapshot) => {
        recoveryEvents.push(
          `recover:${snapshot.key}:${snapshot.previousVersionId}:${snapshot.stagedVersionId}`,
        );
      },
      revalidateBeforeWorkerDeploy: async () => {},
      verifyHealth: async () => {},
    });
    expect(recoveryEvents.slice(0, 2)).toEqual([
      'recover:proxy:previous-proxy:staged-proxy',
      'recover:api:previous-api:staged-api',
    ]);
    expect(recovered.manifest.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'worker-cutover:999:restored' }),
        expect.objectContaining({ key: 'worker-traffic-state:999', resultHash: 'enabled' }),
        expect.objectContaining({ key: 'worker-cutover:1000:committed' }),
      ]),
    );

    function named(key: string) {
      const resource = byKey.get(key)!;
      return { id: resource.id, name: resource.name };
    }

    function cutoverSnapshot(
      workerName: string,
      previousVersionId: string,
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
