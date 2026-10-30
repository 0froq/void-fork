import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CloudflareOperation } from '@void/deploy-cloudflare';
import { expect, it } from 'vite-plus/test';
import {
  decodeCloudflareOperationResult,
  encodeCloudflareOperation,
} from '../../src/cli/cloudflare-process.ts';

function runSecretBulk(input: string) {
  const directory = mkdtempSync(join(tmpdir(), 'void-cf-secret-bulk-test-'));
  try {
    const config = join(directory, 'wrangler.json');
    const capture = join(directory, 'cf-args.json');
    const bulkBody = join(directory, 'bulk-body.json');
    const preload = join(directory, 'capture-cf.mjs');
    writeFileSync(config, JSON.stringify({ name: 'my-worker' }));
    writeFileSync(
      preload,
      `import child from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
child.spawnSync = (_binary, args) => {
  writeFileSync(process.env.VOID_TEST_CF_CAPTURE, JSON.stringify(args));
  const fileIndex = args.indexOf('--file');
  if (fileIndex >= 0) {
    writeFileSync(process.env.VOID_TEST_BULK_BODY, readFileSync(args[fileIndex + 1], 'utf8'));
  }
  return { status: 0, stdout: '{}', stderr: '' };
};
syncBuiltinESMExports();
`,
    );
    const entry = join(
      import.meta.dirname,
      '..',
      '..',
      'src',
      'cli',
      'cloudflare-operation-process.ts',
    );
    const operation: CloudflareOperation = {
      type: 'secret.bulk',
      configPath: config,
      workerName: 'my-worker',
    };
    const child = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(preload).href, entry, ...encodeCloudflareOperation(operation)],
      {
        env: {
          ...process.env,
          VOID_TEST_CF_CAPTURE: capture,
          VOID_TEST_BULK_BODY: bulkBody,
        },
        encoding: 'utf8',
        input,
      },
    );
    return {
      cfArgs: (JSON.parse(readFileSync(capture, 'utf8')) as Array<string>).slice(1),
      bulkPayload: JSON.parse(readFileSync(bulkBody, 'utf8')),
      result: decodeCloudflareOperationResult({
        status: child.status,
        stdout: child.stdout,
        stderr: child.stderr,
      }),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it('wraps Workers secrets bulk payload in a secrets object', () => {
  const { cfArgs, bulkPayload, result } = runSecretBulk(
    JSON.stringify({ ONE: 'first', TWO: 'second' }),
  );
  expect(result.status, result.stderr).toBe(0);
  expect(cfArgs.slice(0, -1)).toEqual([
    'workers',
    'secrets',
    'bulk',
    '--worker',
    'my-worker',
    '--file',
  ]);
  expect(cfArgs.at(-1)).toMatch(/body\.json$/);
  expect(bulkPayload).toEqual({
    secrets: {
      ONE: { type: 'secret_text', text: 'first' },
      TWO: { type: 'secret_text', text: 'second' },
    },
  });
});
