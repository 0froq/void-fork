import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import {
  compatibilityTemplate,
  correctLegacyDeployFixture,
  correctLegacyEmailFixture,
  correctedDeployBodyFixture,
  correctedZoneFixture,
  correctedZoneProvision,
  legacyDeployBodyFixture,
  legacyZoneFixture,
  legacyZoneProvision,
  runIsolatedCompatibilityTests,
} from '../../../../.github/scripts/schema-compat-tests.ts';

const templateUrl = 'postgresql://void_ci:test@127.0.0.1:5432/void_schema_compat';

describe('schema compatibility database isolation', () => {
  it('drains only the known unfinished legacy deploy fixture without changing its assertion', () => {
    const current = readFileSync(
      new URL(
        '../../../../platform/packages/api/test/integration/deploy-direct-r2.test.ts',
        import.meta.url,
      ),
      'utf8',
    ).replaceAll('\r\n', '\n');
    expect(current).toContain(correctedDeployBodyFixture);
    const legacy = current.replace(correctedDeployBodyFixture, legacyDeployBodyFixture);
    expect(correctLegacyDeployFixture(legacy)).toBe(current);
    expect(correctLegacyDeployFixture(current)).toBe(current);
    expect(correctLegacyDeployFixture(legacy + '\n')).toBe(legacy + '\n');
  });

  it('corrects only the checksum-verified legacy fixture and preserves all assertions', () => {
    const current = readFileSync(
      new URL(
        '../../../../platform/packages/api/test/integration/email-connections.test.ts',
        import.meta.url,
      ),
      'utf8',
    ).replaceAll('\r\n', '\n');
    expect(current).toContain(correctedZoneFixture);
    const legacy = current
      .replace(correctedZoneFixture, legacyZoneFixture)
      .replace(correctedZoneProvision, legacyZoneProvision);
    expect(correctLegacyEmailFixture(legacy)).toBe(current);
    expect(correctLegacyEmailFixture(legacy.replaceAll('\n', '\r\n'))).toBe(
      current.replaceAll('\n', '\r\n'),
    );
    expect(correctLegacyEmailFixture(current)).toBe(current);
    expect(correctLegacyEmailFixture(legacy + '\n')).toBe(legacy + '\n');
  });

  it.each([
    'postgresql://void_ci:test@database.example/void_schema_compat',
    'postgresql://void_ci:test@127.0.0.1/production',
    'postgresql://owner:test@127.0.0.1/void_schema_compat',
    templateUrl + '?options=arbitrary',
    'invalid',
  ])('rejects unsafe template configuration before database work: %s', (url) => {
    expect(() => compatibilityTemplate(url)).toThrow();
  });

  it('isolates overlapping files and cleans every owned database after failures', async () => {
    const databases = new Map<string, Set<string>>();
    const destinations = new Set<string>();
    let active = 0;
    let peak = 0;
    const failures = await runIsolatedCompatibilityTests({
      templateUrl,
      files: ['first.test.ts', 'second.test.ts', 'third.test.ts'],
      query: async (statement) => {
        const name = statement.match(/"(void_compat_[a-f0-9]+_\d+)"/)?.[1];
        expect(name).toBeTruthy();
        if (statement.startsWith('CREATE')) {
          expect(statement).toContain('TEMPLATE "void_schema_compat"');
          expect(databases.has(name!)).toBe(false);
          databases.set(name!, new Set());
        } else {
          expect(databases.delete(name!)).toBe(true);
        }
      },
      runTest: async (file, url) => {
        const destination = new URL(url);
        expect(destination.host).toBe('127.0.0.1:5432');
        expect(destination.username).toBe('void_ci');
        expect(destination.password).toBe('test');
        expect(destinations.has(destination.pathname)).toBe(false);
        destinations.add(destination.pathname);
        const tables = databases.get(destination.pathname.slice(1))!;
        // Each file can independently create and leave the same fixture table behind.
        expect(tables.has('__void_platform_installation')).toBe(false);
        tables.add('__void_platform_installation');
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        if (file === 'second.test.ts') {
          throw new Error('fixture failure');
        }
        return file === 'third.test.ts' ? 1 : 0;
      },
    });
    expect(failures.sort()).toEqual(['second.test.ts', 'third.test.ts']);
    expect(peak).toBe(2);
    expect(destinations.size).toBe(3);
    expect(databases.size).toBe(0);
  });
});
