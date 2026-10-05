import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const shared = vi.hoisted(() => ({ dbPath: '', includeExtras: false }));

// Mock the SQLite layer directly (no `importActual`) so the test never loads
// better-sqlite3's native binding — it feeds the export path a canned schema.
vi.mock('../../src/migrations/runner', () => {
  const fakeDb = {
    prepare(sql: string) {
      return {
        get: () =>
          sql.includes('SELECT sql FROM sqlite_master')
            ? { sql: 'CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL)' }
            : undefined,
        all: () => {
          if (sql.startsWith('PRAGMA table_xinfo')) {
            return [
              { name: 'id', hidden: 0 },
              { name: 'title', hidden: 0 },
            ];
          }
          if (sql.includes("type IN ('index','trigger','view')")) {
            return shared.includeExtras
              ? [
                  {
                    type: 'index',
                    name: 'notes_title',
                    tbl_name: 'notes',
                    sql: 'CREATE INDEX notes_title ON notes (title)',
                  },
                  {
                    type: 'trigger',
                    name: 'notes_audit',
                    tbl_name: 'notes',
                    sql: 'CREATE TRIGGER notes_audit AFTER INSERT ON notes BEGIN SELECT 1; END',
                  },
                  {
                    type: 'view',
                    name: 'note_titles',
                    tbl_name: 'note_titles',
                    sql: 'CREATE VIEW note_titles AS SELECT title FROM notes',
                  },
                ]
              : [];
          }
          if (sql.includes('NOT LIKE')) {
            return [{ name: 'notes' }];
          }
          if (sql.startsWith('SELECT * FROM')) {
            return [{ id: 1, title: 'hi' }];
          }
          return [];
        },
      };
    },
    close() {},
  };
  return {
    getMiniflareDatabasePath: () => shared.dbPath,
    openSqliteDatabase: () => fakeDb,
  };
});

const EXPECTED_SQL =
  'CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL);\n' +
  'INSERT INTO "notes" ("id", "title") VALUES (1, \'hi\');\n';

describe('void db export → stdout', () => {
  const roots: Array<string> = [];

  afterEach(() => {
    vi.restoreAllMocks();
    shared.includeExtras = false;
    for (const root of roots.splice(0, roots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('streams pure SQL to stdout without a command banner or stderr noise', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-db-export-'));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { void: '*' } }));
    writeFileSync(join(root, 'void.json'), JSON.stringify({}));
    const dbFile = join(root, 'local.sqlite');
    writeFileSync(dbFile, '');
    shared.dbPath = dbFile;

    const { runDbCommand } = await import('../../src/cli/db.ts');

    let stdout = '';
    let stderr = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    await runDbCommand(root, { action: 'export' });

    expect(stdout).toBe(EXPECTED_SQL);
    expect(stdout.startsWith('CREATE TABLE')).toBe(true);
    expect(stdout).not.toContain('void db');
    expect(stderr).toBe('');
  });

  it('includes indexes, triggers, and views after table data', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-db-export-'));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { void: '*' } }));
    writeFileSync(join(root, 'void.json'), JSON.stringify({}));
    const dbFile = join(root, 'local.sqlite');
    writeFileSync(dbFile, '');
    shared.dbPath = dbFile;
    shared.includeExtras = true;

    const { runDbCommand } = await import('../../src/cli/db.ts');
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    });
    await runDbCommand(root, { action: 'export' });

    expect(stdout).toContain('CREATE INDEX notes_title ON notes (title);');
    expect(stdout).toContain(
      'CREATE TRIGGER notes_audit AFTER INSERT ON notes BEGIN SELECT 1; END;',
    );
    expect(stdout).toContain('CREATE VIEW note_titles AS SELECT title FROM notes;');
    expect(stdout.indexOf('INSERT INTO "notes"')).toBeLessThan(stdout.indexOf('CREATE TRIGGER'));
  });
});
