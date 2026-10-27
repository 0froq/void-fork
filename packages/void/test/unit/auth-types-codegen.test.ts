import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  generateAuthTypes,
  removeAuthTypesIfPresent,
  syncAuthTypesFile,
} from '../../src/codegen/auth-types.ts';

function withTempProject(setup: (root: string) => void): {
  root: string;
  outDir: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'void-auth-codegen-'));
  setup(root);
  const outDir = join(root, '.void');
  mkdirSync(outDir, { recursive: true });
  return {
    root,
    outDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('syncAuthTypesFile', () => {
  it('writes auth.d.ts when a config path is provided and removes it when null', () => {
    const { root, outDir, cleanup } = withTempProject((r) => {
      writeFileSync(join(r, 'auth.ts'), 'export default {};\n');
    });
    try {
      expect(syncAuthTypesFile(join(root, 'auth.ts'), outDir)).toBe(true);
      expect(syncAuthTypesFile(join(root, 'auth.ts'), outDir)).toBe(false);
      expect(syncAuthTypesFile(null, outDir)).toBe(true);
      expect(removeAuthTypesIfPresent(outDir)).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe('generateAuthTypes', () => {
  it('emits a module that augments void/auth AuthUser and AuthSession', () => {
    const { root, outDir, cleanup } = withTempProject((r) => {
      writeFileSync(join(r, 'auth.ts'), 'export default {};');
    });
    try {
      const { dts } = generateAuthTypes(join(root, 'auth.ts'), outDir);
      expect(dts).toContain('export {}');
      expect(dts).toContain('declare module "void/auth"');
      expect(dts).toContain('interface AuthUser extends _InferredUser');
      expect(dts).toContain('interface AuthSession extends _InferredSession');
      expect(dts).toContain('typeof import("../auth.ts")');
      expect(dts).toContain('Auth<_VoidAuthOptions>["$Infer"]["Session"]["user"]');
    } finally {
      cleanup();
    }
  });
});
