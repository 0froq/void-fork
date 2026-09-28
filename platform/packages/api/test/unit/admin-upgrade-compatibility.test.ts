import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { platformDatabaseSchemaDigest } from '@void/platform/installer';
import { expect, it } from 'vite-plus/test';

it('preserves the 0038 database schema used by the running 0.10.14 platform', async () => {
  const root = resolve(import.meta.dirname, '../../drizzle');
  const journal = JSON.parse(readFileSync(resolve(root, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string; idx: number; when: number }>;
  };
  const compatibility = JSON.parse(readFileSync(resolve(root, 'compatibility.json'), 'utf8')) as {
    lineage: string;
    rollbackSafeFrom: Array<{ platformVersion: string; schemaDigest: string }>;
  };
  const baseline = journal.entries.filter((entry) => entry.idx <= 38);
  expect(baseline.at(-1)?.tag).toBe('0038_deployment_admission_protocol');
  const baselineDigest = platformDatabaseSchemaDigest(
    compatibility.lineage,
    baseline.map((entry) => ({
      index: entry.idx,
      tag: entry.tag,
      timestampMillis: entry.when,
      sha256: createHash('sha256')
        .update(readFileSync(resolve(root, `${entry.tag}.sql`)))
        .digest('hex'),
    })),
  );
  expect(baselineDigest).toBe('680a0af38a079d371ee8caa019a2cb6351855361b28d1041017c12fdf2abac46');
  expect(compatibility.rollbackSafeFrom).toContainEqual({
    platformVersion: '0.10.14',
    schemaDigest: baselineDigest,
  });

  const db = new PGlite();
  try {
    for (const entry of baseline) {
      await db.exec(readFileSync(resolve(root, `${entry.tag}.sql`), 'utf8'));
    }
    const columns = async () =>
      (
        await db.query<{
          table_name: string;
          column_name: string;
          data_type: string;
          is_nullable: string;
          column_default: string | null;
        }>(
          "select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position",
        )
      ).rows;
    const before = await columns();
    for (const entry of journal.entries.slice(baseline.length)) {
      await db.exec(readFileSync(resolve(root, `${entry.tag}.sql`), 'utf8'));
    }
    const after = await columns();
    for (const column of before) {
      expect(after).toContainEqual(column);
    }
  } finally {
    await db.close();
  }
}, 30_000);

it('allows rollback to the 0.20.3 schema after adding invitation delivery status', () => {
  const root = resolve(import.meta.dirname, '../../drizzle');
  const journal = JSON.parse(readFileSync(resolve(root, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string; idx: number; when: number }>;
  };
  const compatibility = JSON.parse(readFileSync(resolve(root, 'compatibility.json'), 'utf8')) as {
    lineage: string;
    rollbackSafeFrom: Array<{ platformVersion: string; schemaDigest: string }>;
  };
  const previous = journal.entries.filter((entry) => entry.idx <= 48);
  expect(previous.at(-1)?.tag).toBe('0048_project_teams');
  const schemaDigest = platformDatabaseSchemaDigest(
    compatibility.lineage,
    previous.map((entry) => ({
      index: entry.idx,
      tag: entry.tag,
      timestampMillis: entry.when,
      sha256: createHash('sha256')
        .update(readFileSync(resolve(root, `${entry.tag}.sql`)))
        .digest('hex'),
    })),
  );
  expect(schemaDigest).toBe('089431e230970d03afa429c102613598e88371155cb693c076002c5d632bb0b6');
  expect(compatibility.rollbackSafeFrom).toContainEqual({
    platformVersion: '0.20.3',
    schemaDigest,
  });
});
