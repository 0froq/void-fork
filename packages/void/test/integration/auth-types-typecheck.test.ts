import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { generateAuthTypes } from '../../src/codegen/auth-types.ts';

const workspaceRoot = join(import.meta.dirname, '..', '..', '..', '..');
const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('generated auth types in a consumer project', () => {
  it('types plugin fields and additionalFields on user, session, and context', () => {
    const root = mkdtempSync(join(workspaceRoot, 'playground/kitchen-sink/.tmp-auth-types-'));
    roots.push(root);
    const authFile = join(root, 'auth.ts');
    const outDir = join(root, '.void');
    mkdirSync(outDir);
    writeFileSync(
      authFile,
      'import { admin } from "better-auth/plugins/admin";\n' +
        'import { defineAuth } from "void/auth";\n' +
        'export default defineAuth(({ defaults }) => ({\n' +
        '  ...defaults,\n' +
        '  plugins: [admin()],\n' +
        '  user: { additionalFields: { plan: { type: "string", required: false } } },\n' +
        '}));\n',
    );
    writeFileSync(join(outDir, 'auth.d.ts'), generateAuthTypes(authFile, outDir).dts);
    writeFileSync(
      join(root, 'handler.ts'),
      'import { defineHandler } from "void";\n' +
        'import { getUser, getSession, requireAuth } from "void/auth";\n' +
        'export const loader = defineHandler((c) => {\n' +
        '  const role = c.get("user")?.role;\n' +
        '  const plan = getUser()?.plan;\n' +
        '  const impersonatedBy = c.get("session")?.impersonatedBy;\n' +
        '  const sessionImpersonatedBy = getSession()?.session.impersonatedBy;\n' +
        '  const requiredRole = requireAuth(c).role;\n' +
        '  return { role, plan, impersonatedBy, sessionImpersonatedBy, requiredRole };\n' +
        '});\n',
    );
    const betterAuthPkg = join(workspaceRoot, 'packages/void/node_modules/better-auth');
    const betterAuthRel = relative(root, betterAuthPkg);
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          paths: {
            'better-auth': [betterAuthRel],
            'better-auth/plugins/admin': [
              `${betterAuthRel}/dist/plugins/admin/index.d.mts`,
            ],
          },
        },
        files: ['auth.ts', '.void/auth.d.ts', 'handler.ts'],
      }),
    );

    const result = spawnSync(
      process.execPath,
      [join(workspaceRoot, 'node_modules/typescript/lib/tsc.js'), '--project', root],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
