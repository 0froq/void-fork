import { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { intro, outro } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { runLogsCommand } from '../../src/cli/logs.ts';

vi.mock('../../src/cli/auth.ts', () => ({ getToken: () => 'fixture-token' }));
vi.mock('../../src/cli/project.ts', () => ({
  readDeploymentPlatform: () => 'void',
  readProjectConfig: () => ({ projectId: 'fixture-project', slug: 'my-app' }),
}));
vi.mock('../../src/cli/client.ts', () => ({
  PlatformClient: class {
    async getLogs() {
      return [
        {
          timestamp: 0,
          method: 'POST',
          url: '/api/comments',
          status: '500',
          outcome: 'exception',
          logs: [
            {
              level: 'warn',
              message: ['Cache miss. Refreshing the published page in the background.'],
            },
            {
              level: 'error',
              message: ['Comment could not be saved.\nPlease retry after signing in.'],
            },
          ],
          exceptions: [
            { name: 'Error', message: 'DATABASE_URL is not configured for this deployment.' },
          ],
        },
      ];
    }
  },
}));
vi.mock('@voidzero-dev/vite-plus-prompts', async (original) => ({
  ...(await original<typeof import('@voidzero-dev/vite-plus-prompts')>()),
  intro: vi.fn(),
  outro: vi.fn(),
}));
vi.mock('../../src/cli/output.ts', async (original) => {
  const { default: colors } = await import('picocolors');
  const pc = colors.createColors(true);
  return {
    ...(await original<typeof import('../../src/cli/output.ts')>()),
    pc,
    dim: pc.dim,
  };
});

afterEach(() => vi.restoreAllMocks());

it.each([40, 80])('aligns wrapped log messages and exceptions at %i columns', async (columns) => {
  const output = Object.assign(
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
    { columns },
  );
  vi.spyOn(process, 'stdout', 'get').mockReturnValue(output as typeof process.stdout);
  const print = vi.spyOn(console, 'log').mockImplementation(() => {});
  await runLogsCommand('/fixture', '', '1h');
  expect(intro).not.toHaveBeenCalled();
  expect(stripVTControlCharacters(vi.mocked(outro).mock.calls.at(-1)![0]!)).toBe('1 log entry');
  const messages = print.mock.calls.map((args) => String(args[0] ?? ''));
  const warn = messages.find((line) => line.includes('[warn]'))!;
  const error = messages.find((line) => line.includes('[error]'))!;
  const exception = messages.find((line) => line.includes('[exception]'))!;
  expect(warn).toContain('\x1b[33m[warn]');
  expect(error).toContain('\x1b[31m[error]');
  expect(exception).toContain('\x1b[31m[exception]');
  expect(error).toContain('\n          Please retry');
  for (const [message, indent] of [
    [warn, 9],
    [error, 10],
    [exception, 14],
  ] as const) {
    const lines = stripVTControlCharacters(message).split('\n');
    expect(lines.every((line) => line.length <= columns)).toBe(true);
    expect(lines.slice(1).every((line) => line.startsWith(' '.repeat(indent)))).toBe(true);
  }
});
