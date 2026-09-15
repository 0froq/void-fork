import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { hasHelpPage } from '../../src/cli/help.ts';
import { operatorCommands, parseOperatorArgs } from '../../src/cli/operator-args.ts';
import {
  OPERATOR_KEYRING_SERVICE,
  readOperatorToken,
  resolveOperatorOrigin,
  saveOperatorToken,
} from '../../src/cli/operator-auth.ts';
import { OperatorClient } from '../../src/cli/operator-client.ts';
import { followOperatorLogs, runOperatorCommand } from '../../src/cli/operator-cmd.ts';
import { parsePlatformArgs } from '../../src/cli/platform-args.ts';
import {
  getActivePlatformConnection,
  savePlatformConnection,
} from '../../src/cli/platform-registry.ts';

const keyring = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), remove: vi.fn() }));
vi.mock('../../src/cli/keyring.ts', () => ({
  readKeyringPassword: keyring.read,
  writeKeyringPassword: keyring.write,
  deleteKeyringPassword: keyring.remove,
}));
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'void-operator-'));
  vi.stubEnv('VOID_PLATFORM_REGISTRY_DIR', directory);
  vi.stubEnv('VOID_API_URL', '');
  vi.stubEnv('VOID_OPERATOR_TOKEN', '');
  vi.stubEnv('VOID_TOKEN', 'deployment-only');
  keyring.read.mockReturnValue(null);
  keyring.write.mockReturnValue(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function connect(apiUrl: string) {
  return savePlatformConnection({
    accountId: null,
    apiUrl,
    applicationDomain: null,
    displayName: apiUrl,
    installationId: null,
    kind: 'connected',
    proxyUrl: null,
  });
}

describe('operator argument and help coverage', () => {
  it('has nested help and routable arguments for every operation', () => {
    for (const command of operatorCommands) {
      expect(hasHelpPage(['platform', command.group, command.action])).toBe(true);
      const parameters = (command.positional ?? []).map((name) =>
        name === 'type' ? 'email' : `${name}-value`,
      );
      const result = parsePlatformArgs([command.group, command.action, ...parameters]);
      expect(result).toMatchObject({
        subcommand: 'operator',
        group: command.group,
        action: command.action,
      });
    }
  });
  it('accepts explicit flags before the operator group and encodes IDs', () => {
    expect(
      parsePlatformArgs(['--connection', 'chosen', '--json', 'user', 'show', 'user /?x']),
    ).toMatchObject({ connection: 'chosen', json: true, path: '/users/user%20%2F%3Fx' });
    expect(
      parseOperatorArgs([
        'signup',
        'allow',
        'email',
        '*@example.com',
        '--note',
        'Operators only',
        '--plan',
      ]),
    ).toMatchObject({
      method: 'POST',
      body: { type: 'email', pattern: '*@example.com', note: 'Operators only' },
      plan: true,
    });
  });
  it.each([
    ['user', 'list', '--limit', '101'],
    ['user', 'list', '--page', '1e3'],
    ['user', 'list', '--yes'],
    ['user', 'delete', 'id', '--yes', '--plan'],
    ['user', 'show', '..'],
    ['user', 'list', '--json', '--json'],
    ['user', 'list', '--search'],
    ['user', 'list', '--wat', 'value'],
    ['build', 'logs', 'id', '--since', '-1'],
    ['build', 'logs', 'id', '--since', '9007199254740992'],
    ['worker', 'rollback', 'api', 'version', '--environment', 'preview'],
    ['signup', 'allow', 'typo', '*'],
    ['auth', 'login', '--yes'],
  ])('rejects malformed command %j', (...args) => {
    expect(() => parseOperatorArgs(args)).toThrow();
  });
});

describe('operator credential isolation', () => {
  it('uses only registered explicit connections, without changing the active connection', () => {
    const first = connect('https://one.example');
    const second = connect('https://two.example');
    vi.stubEnv('VOID_API_URL', 'https://override.example');
    expect(resolveOperatorOrigin(first.id)).toBe(first.apiUrl);
    expect(getActivePlatformConnection()?.id).toBe(second.id);
    expect(resolveOperatorOrigin()).toBe('https://override.example');
    expect(() => resolveOperatorOrigin('https://unregistered.example')).toThrow('registered');
  });
  it('rejects headless credentials with an implicit origin', () => {
    const connection = connect('https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    expect(() => resolveOperatorOrigin()).toThrow('explicit');
    expect(resolveOperatorOrigin(connection.id)).toBe(connection.apiUrl);
  });
  it('never falls back to a deploy token and keeps operator credentials in a separate service', () => {
    expect(() => readOperatorToken('https://one.example')).toThrow('No operator session');
    saveOperatorToken('https://one.example', 'operator');
    expect(keyring.write).toHaveBeenCalledWith(
      OPERATOR_KEYRING_SERVICE,
      expect.stringMatching(/^platform:/),
      'operator',
    );
    keyring.write.mockReturnValue(false);
    expect(() => saveOperatorToken('https://one.example', 'operator')).toThrow('keychain');
  });
});

describe('operator transport and execution', () => {
  it('encodes queries and refuses credential-bearing redirects without retrying', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { Location: 'https://evil.example' } }),
      );
    const client = new OperatorClient('https://one.example', 'operator', fetcher);
    await expect(
      client.request('/users', { query: { search: 'x&admin=1' } }),
    ).rejects.toMatchObject({ code: 'redirect_rejected' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      'https://one.example/operator/v1/users?search=x%26admin%3D1',
    );
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      redirect: 'manual',
      headers: { Authorization: 'Bearer operator' },
      signal: expect.any(AbortSignal),
    });
  });
  it('preserves structured partial errors and never retries mutations', async () => {
    const details = { completed: ['one'], failed: ['two'] };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: 'partial_failure', message: 'Some resources remain.', details },
          { status: 502 },
        ),
      );
    await expect(
      new OperatorClient('https://one.example', 'token', fetcher).request('/users/id/delete', {
        method: 'POST',
        body: {},
      }),
    ).rejects.toMatchObject({ code: 'partial_failure', details });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('requires authorization before preview and validates preview before executing', async () => {
    vi.stubEnv('VOID_API_URL', 'https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    await expect(runOperatorCommand(parseOperatorArgs(['user', 'delete', 'id']))).rejects.toThrow(
      '--yes',
    );
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      runOperatorCommand(parseOperatorArgs(['user', 'delete', 'id', '--yes'])),
    ).rejects.toThrow('valid mutation preview');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('performs plan only and pins rollback-all execution to previewed versions', async () => {
    vi.stubEnv('VOID_API_URL', 'https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const preview = {
      dryRun: true,
      action: 'workers.rollback-all',
      target: 'production',
      versions: { api: 'version-a' },
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(preview));
    vi.stubGlobal('fetch', fetcher);
    await runOperatorCommand(parseOperatorArgs(['worker', 'rollback-all', '--plan', '--json']));
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockClear();
    await runOperatorCommand(parseOperatorArgs(['worker', 'rollback-all', '--yes']));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({
      versions: { api: 'version-a' },
    });
  });
  it('drains runtime cursors and rejects repeated cursors instead of spinning', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ data: [], nextCursor: 'page-2', watermark: '2030-01-01T00:00:00Z' }),
      );
    await expect(
      followOperatorLogs(
        new OperatorClient('https://one.example', 'token', fetcher),
        parseOperatorArgs(['deployment', 'logs', 'id', '--follow', '--since', '1h']),
      ),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]![0])).toContain('cursor=page-2');
    expect(String(fetcher.mock.calls[1]![0])).toContain('since=1h');
  });
  it('renders deployment status, log messages, and exceptions in human output', async () => {
    vi.stubEnv('VOID_API_URL', 'https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    const write = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          data: [
            {
              timestamp: 1234,
              method: 'GET',
              url: '/broken',
              status: '503',
              outcome: 'exception',
              logs: [{ level: 'error', message: 'request failed' }],
              exceptions: [{ name: 'TypeError', message: 'missing value' }],
            },
          ],
          nextCursor: null,
          watermark: '1235',
        }),
      ),
    );

    await runOperatorCommand(parseOperatorArgs(['deployment', 'logs', 'deployment-1']));

    expect(write.mock.calls.map(([line]) => String(line))).toEqual([
      '1234 GET /broken 503',
      '  [error] request failed',
      '  TypeError: missing value',
    ]);
  });

  it('renders every worker and audit event field without table-column truncation', async () => {
    vi.stubEnv('VOID_API_URL', 'https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    const write = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          batchId: 'batch-1',
          environment: 'production',
          events: [
            {
              id: 'event-1',
              batch_id: 'batch-1',
              action: 'rollback_all',
              worker_name: 'api',
              environment: 'production',
              version_id: 'version-failed',
              script_name: 'void-api',
              status: 'failed',
              error_message: 'Version no longer exists.',
              auditError: 'Could not persist the outcome.',
              admin_login: 'operator',
              created_at: '2030-01-01T00:00:00Z',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          events: [
            {
              id: 'audit-1',
              login: 'operator',
              action: 'workers/api/rollback',
              target: '{"worker":"api","versionId":"version-failed"}',
              status: 'failed',
              http_status: 207,
              created_at: '2030-01-01T00:00:00Z',
            },
          ],
          page: 1,
          limit: 25,
          total: 1,
        }),
      );
    vi.stubGlobal('fetch', fetcher);

    await runOperatorCommand(parseOperatorArgs(['worker', 'events', 'batch-1']));
    await runOperatorCommand(parseOperatorArgs(['system', 'events']));

    const rendered = write.mock.calls.map(([line]) => String(line)).join('\n');
    expect(rendered).toContain('version id: version-failed');
    expect(rendered).toContain('error message: Version no longer exists.');
    expect(rendered).toContain('audit Error: Could not persist the outcome.');
    expect(rendered).toContain('action: workers/api/rollback');
    expect(rendered).toContain('target: {"worker":"api","versionId":"version-failed"}');
  });

  it('follows build log sequence and stops when terminal', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ lines: [{ seq: 3, text: 'done' }], lastSeq: 3, terminal: true }),
      );
    await followOperatorLogs(
      new OperatorClient('https://one.example', 'token', fetcher),
      parseOperatorArgs(['build', 'logs', 'id', '--follow', '--since', '2', '--json']),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]![0])).toContain('since=2');
    expect(String(fetcher.mock.calls[1]![0])).toContain('since=3');
  });
});
