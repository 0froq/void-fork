import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { createProjectTsconfig } from '../../src/codegen/project-tsconfig.ts';

const workspaceRoot = join(import.meta.dirname, '..', '..', '..', '..');
const roots: Array<string> = [];

function runPrepare(root: string): void {
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'const { prepareProject } = await import(process.argv[1]); await prepareProject(process.argv[2]);',
      fileURLToPath(new URL('../../src/codegen/prepare.ts', import.meta.url)),
      root,
    ],
    { stdio: 'pipe' },
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('auth types prepare lifecycle', () => {
  it('writes auth.d.ts and updates tsconfig after prepare; removes both when auth.ts is gone', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-auth-prepare-'));
    roots.push(root);
    mkdirSync(join(root, '.void'), { recursive: true });
    const voidAuthTypes = relative(root, join(workspaceRoot, 'packages/void/src/runtime/auth.ts'));
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { paths: { 'void/auth': [voidAuthTypes] } },
      }),
    );
    writeFileSync(
      join(root, 'auth.ts'),
      'import type { VoidAuthConfig } from "void/auth";\nexport default {} satisfies VoidAuthConfig;\n',
    );

    expect(createProjectTsconfig(root).files).not.toContain('auth.d.ts');

    runPrepare(root);

    expect(existsSync(join(root, '.void', 'auth.d.ts'))).toBe(true);
    const withAuth = JSON.parse(readFileSync(join(root, '.void', 'tsconfig.json'), 'utf8')) as {
      files: Array<string>;
    };
    expect(withAuth.files).toContain('auth.d.ts');

    rmSync(join(root, 'auth.ts'));
    runPrepare(root);

    expect(existsSync(join(root, '.void', 'auth.d.ts'))).toBe(false);
    const withoutAuth = JSON.parse(readFileSync(join(root, '.void', 'tsconfig.json'), 'utf8')) as {
      files: Array<string>;
    };
    expect(withoutAuth.files).not.toContain('auth.d.ts');
  }, 30_000);
});
