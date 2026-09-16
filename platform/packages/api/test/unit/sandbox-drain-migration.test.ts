import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

const drizzleRoot = new URL('../../drizzle/', import.meta.url);

function readJson(path: URL): unknown {
  return JSON.parse(readFileSync(fileURLToPath(path), 'utf8')) as unknown;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('Sandbox drain database compatibility', () => {
  it('pins the verified 0035 baseline digest and keeps 0036 additive', () => {
    const compatibility = readJson(new URL('compatibility.json', drizzleRoot)) as {
      lineage: string;
      rollbackSafeFrom: Array<{ platformVersion: string; schemaDigest: string }>;
    };
    const journal = readJson(new URL('meta/_journal.json', drizzleRoot)) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const baselineMigrations = journal.entries
      .filter((entry) => entry.idx <= 35)
      .map((entry) => ({
        index: entry.idx,
        sha256: sha256(readFileSync(new URL(`${entry.tag}.sql`, drizzleRoot))),
        tag: entry.tag,
        timestampMillis: entry.when,
      }));
    const baselineDigest = sha256(
      JSON.stringify({ lineage: compatibility.lineage, migrations: baselineMigrations }),
    );
    expect(baselineDigest).toBe('6e6ab83f109f3c1ce267968914d50c8c826d7e1a6f2821bfd44918766325b7d6');
    expect(compatibility.rollbackSafeFrom).toContainEqual({
      platformVersion: '0.10.14',
      schemaDigest: baselineDigest,
    });

    const drainMigration = readFileSync(new URL('0036_unusual_bloodaxe.sql', drizzleRoot), 'utf8');
    const statements = drainMigration
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^CREATE TABLE "sandbox_drain_checkpoints"/);
    expect(statements[1]).toMatch(/^CREATE INDEX "idx_deployments_created_id"/);
    expect(drainMigration).not.toMatch(/\b(?:ALTER|DROP|TRUNCATE|DELETE|UPDATE)\b/i);
  });
});
