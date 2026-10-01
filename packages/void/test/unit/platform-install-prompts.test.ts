import { createPlatformDeploymentManifest } from '@void/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { pc } from '../../src/cli/output.ts';
import { parsePlatformArgs } from '../../src/cli/platform-args.ts';
import { PlatformCloudflareClient } from '../../src/cli/platform-cloudflare.ts';
import { loadPlatformRuntime } from '../../src/cli/platform-installer.ts';
import { runPlatformLifecycleCommand } from '../../src/cli/platform-lifecycle.ts';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  multiselect: vi.fn(),
  note: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  plan: vi.fn(),
}));
vi.mock('@clack/prompts', async (original) => ({
  ...(await original<typeof import('@clack/prompts')>()),
  // These fixtures retain GitHub-only setup; Access choices have their own matrix.
  confirm: (input: { message: string }) =>
    input.message === 'Also protect the platform UI and APIs with Cloudflare Access?'
      ? Promise.resolve(false)
      : mocks.confirm(input),
  multiselect: mocks.multiselect,
  select: mocks.select,
  text: mocks.text,
  intro: vi.fn(),
  note: mocks.note,
  outro: vi.fn(),
}));
vi.mock('../../src/cli/platform-auth.ts', () => ({
  resolvePlatformCloudflareCredential: async () => ({ source: 'oauth', token: 'test-token' }),
  resolvePlatformCloudflareCredentialWithInput: async (input: () => Promise<unknown>) => ({
    input: await input(),
    credential: { source: 'oauth', token: 'test-token' },
  }),
  assertPlatformOperatorCredentialCanApplyPlan: vi.fn(),
}));
vi.mock('../../src/cli/platform-registry.ts', async (original) => ({
  ...(await original<typeof import('../../src/cli/platform-registry.ts')>()),
  assertPlatformInstallationSlugAvailable: vi.fn(),
  listInstallationManifests: () => [],
}));
vi.mock('../../src/cli/platform-plan.ts', async (original) => ({
  ...(await original<typeof import('../../src/cli/platform-plan.ts')>()),
  createPlatformInstallPlan: mocks.plan,
}));

const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const args = [
  'install',
  '--plan',
  '--name',
  'test',
  '--display-name',
  'Test',
  '--account',
  'account',
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.multiselect.mockResolvedValue(['github']);
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(PlatformCloudflareClient.prototype, 'listAccounts').mockResolvedValue([
    { id: 'account', name: 'Account' },
  ]);
  vi.spyOn(PlatformCloudflareClient.prototype, 'listHyperdriveConfigs').mockResolvedValue([]);
  mocks.text.mockResolvedValue('');
  mocks.select.mockImplementation(async ({ message, options }) =>
    message === 'How should Void set up Hyperdrive?' ||
    message === 'Which Hyperdrive should Void use?'
      ? options[0].value
      : 'workers-dev',
  );
  mocks.confirm.mockImplementation(async ({ message }) =>
    message.startsWith('Use ') ? true : false,
  );
  mocks.plan.mockResolvedValue({
    account: { id: 'account', name: 'Account' },
    actions: [],
    apiUrl: 'https://api.test.workers.dev',
    proxyUrl: 'https://proxy.test.workers.dev',
    deployment: createPlatformDeploymentManifest({
      installationSlug: 'test',
      displayName: 'Test',
      application: { baseDomain: 'example.com', zoneName: 'example.com' },
    }),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (ttyDescriptor) {
    Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
  } else {
    Reflect.deleteProperty(process.stdin, 'isTTY');
  }
});

describe('interactive platform installation prompts', () => {
  it('lists and confirms an externally managed Hyperdrive with an unrelated name', async () => {
    vi.spyOn(PlatformCloudflareClient.prototype, 'listHyperdriveConfigs').mockResolvedValue([
      { id: 'other-id', name: 'another-database' },
      { id: 'terraform-id', name: 'company-managed-postgres' },
    ]);
    vi.spyOn(PlatformCloudflareClient.prototype, 'getHyperdriveConfig').mockResolvedValue({
      id: 'terraform-id',
      name: 'company-managed-postgres',
      origin: {
        database: 'void_platform',
        host: 'hyperdrive-productiondb.databases.cfdata.org/itdb/primary',
        port: 5432,
        scheme: 'postgresql',
        user: 'hyperdrive_void_platform_service',
      },
      cachingDisabled: true,
    });
    mocks.select.mockImplementation(async ({ message }) =>
      message === 'How should Void set up Hyperdrive?'
        ? 'existing'
        : message === 'Which Hyperdrive should Void use?'
          ? 'terraform-id'
          : 'workers-dev',
    );
    await runPlatformLifecycleCommand(parsePlatformArgs([...args, '--workers-dev']));

    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining('Database: void_platform'),
      'Existing Hyperdrive company-managed-postgres',
    );
    expect(mocks.select).toHaveBeenCalledWith({
      message: 'How should Void set up Hyperdrive?',
      options: [
        { value: 'existing', label: 'Use an existing Hyperdrive' },
        { value: 'create', label: 'Let Void create Hyperdrive', hint: 'recommended' },
        { value: 'setup', label: 'Set up a separately managed Hyperdrive' },
      ],
    });
    expect(mocks.select).toHaveBeenCalledWith({
      message: 'Which Hyperdrive should Void use?',
      options: [
        { value: 'other-id', label: 'another-database', hint: 'other-id' },
        { value: 'terraform-id', label: 'company-managed-postgres', hint: 'terraform-id' },
      ],
    });
    expect(mocks.confirm).toHaveBeenCalledWith({
      message: 'Use company-managed-postgres for this platform?',
      initialValue: true,
    });
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        externalHyperdrive: {
          id: 'terraform-id',
          name: 'company-managed-postgres',
          host: 'hyperdrive-productiondb.databases.cfdata.org/itdb/primary',
          user: 'hyperdrive_void_platform_service',
        },
      }),
      null,
      expect.anything(),
    );
    vi.clearAllMocks();
    await runPlatformLifecycleCommand(
      parsePlatformArgs([
        ...args,
        '--workers-dev',
        '--no-control-plane-domain',
        '--hyperdrive',
        'terraform-id',
        '--login-methods',
        'github',
        '--no-access-protection',
      ]),
    );
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.multiselect).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(PlatformCloudflareClient.prototype.getHyperdriveConfig).toHaveBeenCalledWith(
      'account',
      'terraform-id',
    );
    expect(mocks.plan.mock.calls[0]![1].externalHyperdrive.id).toBe('terraform-id');
  });

  it('keeps the environment override for unattended installation', async () => {
    vi.stubEnv('VOID_PLATFORM_HYPERDRIVE_ID', 'terraform-id');
    vi.stubEnv('VOID_PLATFORM_HYPERDRIVE_ORIGIN_HOST', 'db.example.com');
    vi.stubEnv('VOID_PLATFORM_HYPERDRIVE_ORIGIN_USER', 'runtime_user');

    await runPlatformLifecycleCommand(parsePlatformArgs([...args, '--workers-dev']));

    expect(PlatformCloudflareClient.prototype.listHyperdriveConfigs).not.toHaveBeenCalled();
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        externalHyperdrive: {
          id: 'terraform-id',
          host: 'db.example.com',
          user: 'runtime_user',
        },
      }),
      null,
      expect.anything(),
    );
  });

  it('suggests a matching name without requiring it', async () => {
    vi.spyOn(PlatformCloudflareClient.prototype, 'listHyperdriveConfigs').mockResolvedValue([
      { id: 'other-id', name: 'company-managed-postgres' },
      { id: 'suggested-id', name: 'void-test-database' },
    ]);
    vi.spyOn(PlatformCloudflareClient.prototype, 'getHyperdriveConfig').mockResolvedValue({
      id: 'suggested-id',
      name: 'void-test-database',
      origin: {
        database: 'void_platform',
        host: 'db.example.com',
        port: 5432,
        scheme: 'postgresql',
        user: 'runtime_user',
      },
      cachingDisabled: true,
    });

    await runPlatformLifecycleCommand(parsePlatformArgs([...args, '--workers-dev']));

    expect(mocks.select).toHaveBeenCalledWith({
      message: 'How should Void set up Hyperdrive?',
      options: [
        { value: 'existing', label: 'Use an existing Hyperdrive' },
        { value: 'setup', label: 'Set up a separately managed Hyperdrive' },
      ],
    });
    expect(mocks.select).toHaveBeenCalledWith({
      message: 'Which Hyperdrive should Void use?',
      options: [
        {
          value: 'suggested-id',
          label: 'void-test-database',
          hint: 'suggested · suggested-id',
        },
        { value: 'other-id', label: 'company-managed-postgres', hint: 'other-id' },
      ],
    });
  });

  it('explains how to set up a separately managed Hyperdrive before planning', async () => {
    mocks.select.mockResolvedValue('setup');

    await runPlatformLifecycleCommand(parsePlatformArgs([...args, '--workers-dev']));

    expect(mocks.select).toHaveBeenCalledWith({
      message: 'How should Void set up Hyperdrive?',
      options: [
        { value: 'create', label: 'Let Void create Hyperdrive', hint: 'recommended' },
        { value: 'setup', label: 'Set up a separately managed Hyperdrive' },
      ],
    });
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining('with any unused name such as void-test-database'),
      'Set up Hyperdrive first',
    );
    expect(mocks.plan).not.toHaveBeenCalled();
  });

  it('stops before planning if an existing Hyperdrive is declined', async () => {
    vi.spyOn(PlatformCloudflareClient.prototype, 'listHyperdriveConfigs').mockResolvedValue([
      { id: 'terraform-id', name: 'void-test-database' },
    ]);
    vi.spyOn(PlatformCloudflareClient.prototype, 'getHyperdriveConfig').mockResolvedValue({
      id: 'terraform-id',
      name: 'void-test-database',
      origin: {
        database: 'void_platform',
        host: 'db.example.com',
        port: 5432,
        scheme: 'postgresql',
        user: 'runtime_user',
      },
      cachingDisabled: true,
    });

    mocks.confirm.mockResolvedValue(false);

    await expect(
      runPlatformLifecycleCommand(parsePlatformArgs([...args, '--workers-dev'])),
    ).rejects.toThrow('Cancelled');
    expect(mocks.plan).not.toHaveBeenCalled();
  });

  it('bolds platform runtime labels without styling their values', async () => {
    vi.spyOn(pc, 'bold').mockImplementation(pc.createColors(true).bold);
    const runtime = loadPlatformRuntime('');
    await runPlatformLifecycleCommand(parsePlatformArgs([...args, '--workers-dev']));
    expect(mocks.note).toHaveBeenCalledWith(
      [
        `\u001b[1mVersion:\u001b[22m ${runtime.manifest.platformVersion}`,
        `\u001b[1mSource:\u001b[22m ${runtime.source}`,
        `\u001b[1mRevision:\u001b[22m ${runtime.manifest.sourceRevision ?? 'not recorded'}`,
        `\u001b[1mManifest SHA-256:\u001b[22m ${runtime.manifestSha256}`,
      ].join('\n'),
      'Platform runtime',
    );
  });

  it('uses a placeholder, not a prefilled installation name', async () => {
    mocks.text.mockResolvedValueOnce('my-team');
    await runPlatformLifecycleCommand(
      parsePlatformArgs(['install', '--plan', '--account', 'account', '--workers-dev']),
    );
    const prompt = mocks.text.mock.calls[0]![0];
    expect(prompt).toMatchObject({ message: 'Installation name:', placeholder: 'company' });
    expect(prompt).not.toHaveProperty('initialValue');
    expect(prompt.validate('')).toBe('A value is required.');
    expect(prompt.validate('my-team')).toBeUndefined();
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ installationSlug: 'my-team' }),
      null,
      expect.anything(),
    );
    expect(mocks.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Platform display name:',
        initialValue: 'my-team Void',
      }),
    );
  });

  it.each([
    { name: 'explicit flag', flags: ['--workers-dev'] },
    { name: 'interactive selection', flags: [] },
  ])('skips the dedicated-zone question for testing mode: $name', async ({ flags }) => {
    await runPlatformLifecycleCommand(parsePlatformArgs([...args, ...flags]));
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workersDev: true, zoneName: '', dedicatedZone: false }),
      null,
      expect.anything(),
    );
  });

  it('keeps the named catch-all choice for an application domain at the zone apex', async () => {
    mocks.confirm.mockResolvedValue(true);
    await runPlatformLifecycleCommand(
      parsePlatformArgs([...args, '--application-domain', 'example.com', '--zone', 'example.com']),
    );
    expect(mocks.confirm).toHaveBeenCalledWith({
      message: 'Dedicate all unmatched example.com traffic to Void apps?',
      initialValue: false,
    });
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dedicatedZone: true }),
      null,
      expect.anything(),
    );
  });

  it('does not offer zone-wide routing for a nested application domain', async () => {
    await runPlatformLifecycleCommand(
      parsePlatformArgs([
        ...args,
        '--application-domain',
        'apps.example.com',
        '--zone',
        'example.com',
      ]),
    );
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
});
