import { vi } from 'vitest';

// Shared test db reference — set by setupEnv(), read by the createDb mock.
// When null, createDb falls through to the real implementation.
let testDb: import('../../src/db').Db | null = null;

export function setTestDb(db: import('../../src/db').Db) {
  testDb = db;
}

export function clearTestDb() {
  testDb = null;
}

vi.mock('../../src/db', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/db')>();
  return {
    ...mod,
    createDb: (...args: [string]) => testDb ?? mod.createDb(...args),
  };
});
