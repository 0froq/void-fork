import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { postgresConcurrencyTestFiles } from '../../../../.github/scripts/postgres-concurrency-tests.ts';

const roots: Array<string> = [];

function createFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'void-postgres-selection-'));
  roots.push(root);
  const directory = join(root, 'platform/packages/api/test/integration');
  mkdirSync(directory, { recursive: true });
  for (const [file, source] of Object.entries(files)) {
    const path = join(directory, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('PostgreSQL concurrency test selection', () => {
  it('finds direct, aliased, multiline and computed environment gates without selecting comments', () => {
    const root = createFixture({
      'direct.test.ts': 'it.runIf(Boolean(process.env.VOID_TEST_DATABASE_URL))("race", () => {});',
      'aliased.test.ts': 'const postgres = it.runIf(Boolean(process.env.VOID_TEST_DATABASE_URL));',
      'nested/multiline.test.ts': `it
        .runIf(Boolean(process.env.VOID_TEST_DATABASE_URL))
        .each(['one', 'two'])('race', () => {});`,
      'computed.test.ts': `const connectionString = process['env']['VOID_TEST_DATABASE_URL'];`,
      'ordinary.test.ts': 'it("ordinary test", () => {});',
      'comment.test.ts': '// it.runIf(Boolean(process.env.VOID_TEST_DATABASE_URL));',
      'string.test.ts': `const example = 'process.env.VOID_TEST_DATABASE_URL';`,
      'helper.ts': 'const databaseUrl = process.env.VOID_TEST_DATABASE_URL;',
    });
    expect(postgresConcurrencyTestFiles(root)).toEqual(
      ['aliased.test.ts', 'computed.test.ts', 'direct.test.ts', 'nested/multiline.test.ts'].map(
        (file) => `platform/packages/api/test/integration/${file}`,
      ),
    );
  });

  it('fails when there is no real PostgreSQL coverage to execute', () => {
    const root = createFixture({ 'ordinary.test.ts': 'it("ordinary test", () => {});' });
    expect(() => postgresConcurrencyTestFiles(root)).toThrow(
      'No PostgreSQL concurrency test files',
    );
  });

  it('fails on an invalid test file instead of silently omitting its coverage', () => {
    const root = createFixture({ 'invalid.test.ts': 'it.runIf(' });
    expect(() => postgresConcurrencyTestFiles(root)).toThrow(
      'Cannot inspect PostgreSQL test coverage',
    );
  });
});
