import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import {
  changedFiles,
  deletedFiles,
  planAffectedTests,
  type TestFile,
} from '../../../../test/affected-tests.ts';

const tests: Array<TestFile> = [
  { path: 'packages/void/test/unit/router.test.ts', project: 'unit', source: '' },
  { path: 'packages/react/test/unit/link.test.ts', project: 'unit', source: '' },
  {
    path: 'packages/react/test/integration/pages.test.ts',
    project: 'parallel-integration',
    source: "const fixture = 'playground/react-pages';",
  },
  {
    path: 'packages/void/test/integration/spa.test.ts',
    project: 'parallel-integration',
    source: "const fixture = 'playground/spa';",
  },
  {
    path: 'platform/packages/api/test/integration/account.test.ts',
    project: 'platform-api-integration-threads',
    source: '',
  },
  {
    path: 'platform/packages/api/test/integration/timezone.test.ts',
    project: 'platform-api-integration',
    source: '',
  },
  { path: 'platform/packages/proxy/test/proxy.test.ts', project: 'platform-unit', source: '' },
];

describe('affected test planning', () => {
  it('leaves a changed test to the native import graph without adding integrations', () => {
    const plan = planAffectedTests([tests[0].path], tests);
    expect(plan.full).toBe(false);
    expect(plan.build).toBe(false);
    expect(plan.related).toEqual([tests[0].path]);
    expect([...plan.forced]).toEqual([]);
  });

  it('adds SDK integrations and refreshes built public exports for SDK source changes', () => {
    const plan = planAffectedTests(['packages/void/src/runtime/router.ts'], tests);
    expect(plan.full).toBe(false);
    expect(plan.build).toBe(true);
    expect([...plan.forced]).toEqual(
      tests.filter((test) => test.project === 'parallel-integration').map((test) => test.path),
    );
  });

  it('selects filesystem consumers for a changed playground including Markdown content', () => {
    const plan = planAffectedTests(['playground/react-pages/pages/index.md'], tests);
    expect([...plan.forced]).toEqual([tests[2].path]);
    expect(plan.build).toBe(false);
  });

  it('fails closed for a playground without an explicit filesystem consumer', () => {
    const plan = planAffectedTests(['playground/new-app/src/index.ts'], tests);
    expect([...plan.forced]).toEqual([tests[2].path, tests[3].path]);
  });

  it.each([
    'platform/packages/api/src/index.ts',
    'platform/packages/api/migrations/0001.sql',
    'platform/packages/api/test/integration/setup.ts',
  ])('covers both API pools for non-imported resources: %s', (path) => {
    const plan = planAffectedTests([path], tests);
    expect([...plan.forced]).toEqual([tests[4].path, tests[5].path]);
  });

  it('does not select another platform package for package-local fixtures', () => {
    const plan = planAffectedTests(['platform/packages/proxy/test/fixture.json'], tests);
    expect([...plan.forced]).toEqual([tests[6].path]);
  });

  it('normalizes Windows paths and deduplicates overlapping fallbacks', () => {
    const plan = planAffectedTests(
      ['packages\\void\\src\\index.ts', 'packages/react/src/index.ts'],
      tests,
    );
    expect([...plan.forced]).toEqual([tests[2].path, tests[3].path]);
    expect(plan.related[0]).toBe('packages/void/src/index.ts');
  });

  it.each([
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'packages/react/vite.config.ts',
    'packages/react/tsconfig.json',
    'test/browser-helpers.ts',
    '.github/workflows/test.yml',
    'scripts/build.mjs',
    'new-tooling/file.txt',
  ])('falls back to the full selection for unsafe changes: %s', (path) => {
    expect(planAffectedTests([path], tests).full).toBe(true);
  });

  it('runs the full selection for deleted imports instead of trusting an incomplete graph', () => {
    expect(
      planAffectedTests(['packages/void/src/removed.ts'], tests, ['packages/void/src/removed.ts'])
        .full,
    ).toBe(true);
  });

  it('skips documentation but not fixture content or unknown Markdown templates', () => {
    const plan = planAffectedTests(
      ['docs/guide/testing.md', 'packages/void/README.md', 'AGENTS.md'],
      tests,
    );
    expect(plan.full).toBe(false);
    expect(plan.related).toEqual([]);
    expect(planAffectedTests(['templates/new.md'], tests).full).toBe(true);
  });

  it('includes all owning tests for package fixtures read outside the import graph', () => {
    expect([...planAffectedTests(['packages/void/test/fixtures/data.json'], tests).forced]).toEqual(
      [tests[0].path, tests[3].path],
    );
  });
});

describe('Git change collection', () => {
  it('includes staged, unstaged, untracked, deleted, renamed, and committed branch paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-affected-git-'));
    const git = (...args: Array<string>) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    const write = (path: string, content = path) => writeFileSync(join(root, path), content);
    try {
      git('init', '--quiet');
      git('config', 'user.email', 'tests@example.com');
      git('config', 'user.name', 'Tests');
      for (const path of [
        'staged.ts',
        'unstaged.ts',
        'deleted.ts',
        'old name.ts',
        'committed.ts',
        'cancelled.ts',
      ]) {
        write(path);
      }
      git('add', '.');
      git('commit', '--quiet', '--no-verify', '-m', 'Base.');
      expect(changedFiles(root)).toEqual([]);
      const base = git('rev-parse', 'HEAD').toString().trim();
      write('committed.ts', 'changed');
      git('add', '.');
      git('commit', '--quiet', '--no-verify', '-m', 'Branch change.');
      write('staged.ts', 'changed');
      git('add', 'staged.ts');
      write('unstaged.ts', 'changed');
      write('cancelled.ts', 'staged change');
      git('add', 'cancelled.ts');
      write('cancelled.ts');
      mkdirSync(join(root, 'new folder'));
      write('new folder/untracked.ts');
      git('rm', 'deleted.ts');
      git('mv', 'old name.ts', 'new name.ts');
      const local = [
        'cancelled.ts',
        'deleted.ts',
        'new folder/untracked.ts',
        'new name.ts',
        'old name.ts',
        'staged.ts',
        'unstaged.ts',
      ].sort();
      expect(changedFiles(root)).toEqual(local);
      expect(changedFiles(root, base)).toEqual([...local, 'committed.ts'].sort());
      expect(deletedFiles(root, local)).toEqual(['deleted.ts', 'old name.ts']);
      expect(() => changedFiles(root, 'missing-ref')).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

it('previews the native transitive import graph without running test or setup code', () => {
  const root = mkdtempSync(join(tmpdir(), 'void-affected-preview-'));
  const repository = fileURLToPath(new URL('../../../../', import.meta.url));
  const git = (...args: Array<string>) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  const write = (path: string, content: string) => writeFileSync(join(root, path), content);
  try {
    mkdirSync(join(root, 'packages/void/src'), { recursive: true });
    mkdirSync(join(root, 'packages/void/test/unit'), { recursive: true });
    symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'), 'junction');
    write('.gitignore', 'node_modules\n');
    write('package.json', '{"type":"module"}');
    write(
      'vite.config.ts',
      "export default { test: { projects: [{ test: { name: 'unit', fsModuleCache: true, globalSetup: ['./setup.ts'], include: ['packages/*/test/unit/*.test.ts'] } }] } };",
    );
    write('setup.ts', "throw new Error('preview must not run setup');");
    write('packages/void/src/leaf.ts', 'export const value = 1;');
    write('packages/void/src/barrel.ts', "export { value } from './leaf.ts';");
    write(
      'packages/void/test/unit/affected.test.ts',
      "import { value } from '../../src/barrel.ts'; throw new Error(`preview must not execute ${value}`);",
    );
    write(
      'packages/void/test/unit/unrelated.test.ts',
      "throw new Error('unrelated test must not execute');",
    );
    git('init', '--quiet');
    git('add', '.');
    git(
      '-c',
      'user.email=tests@example.com',
      '-c',
      'user.name=Tests',
      'commit',
      '--quiet',
      '--no-verify',
      '-m',
      'Fixture.',
    );
    write('packages/void/src/leaf.ts', 'export const value = 2;');
    const runner = new URL('../../../../test/affected.mjs', import.meta.url).href;
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { runAffected } from ${JSON.stringify(runner)}; await runAffected(${JSON.stringify(root)}, { list: true });`,
      ],
      { cwd: root, encoding: 'utf8', stdio: 'pipe', timeout: 15_000 },
    );
    expect(output).toContain('Selected 1/2 test files');
    expect(output).toContain('[unit] packages/void/test/unit/affected.test.ts');
    expect(output).not.toContain('[unit] packages/void/test/unit/unrelated.test.ts');
    write('setup.ts', 'export default function setup() {}');
    git('add', '.');
    git(
      '-c',
      'user.email=tests@example.com',
      '-c',
      'user.name=Tests',
      'commit',
      '--quiet',
      '--no-verify',
      '-m',
      'Prime fixture.',
    );
    const run = () =>
      spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { runAffected } from ${JSON.stringify(runner)}; await runAffected(${JSON.stringify(root)}, {});`,
        ],
        { cwd: root, encoding: 'utf8', timeout: 15_000 },
      );
    write(
      'packages/void/test/unit/affected.test.ts',
      "import { expect, it } from 'vite-plus/test'; import { value } from '../../src/barrel.ts'; it('value', () => expect(value).toBe(2));",
    );
    const passed = run();
    expect(passed.error).toBeUndefined();
    expect(passed.stdout).toContain('Selected 1/2 test files');
    expect(passed.status, passed.stderr).toBe(0);
    write(
      'packages/void/test/unit/affected.test.ts',
      "import { expect, it } from 'vite-plus/test'; import { value } from '../../src/barrel.ts'; it('changed value', () => expect(value).toBe(3));",
    );
    const failed = run();
    expect(failed.error).toBeUndefined();
    expect(failed.status).toBe(1);
    expect(failed.stdout + failed.stderr).toContain('expected 2 to be 3');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
