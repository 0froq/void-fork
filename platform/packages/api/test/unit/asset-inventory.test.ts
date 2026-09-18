import { describe, expect, it, vi } from 'vite-plus/test';
import { findR2Assets } from '../../src/asset-inventory.ts';

describe('asset inventory', () => {
  it('does no I/O for an empty manifest', async () => {
    const head = vi.fn();
    const list = vi.fn();
    expect(await findR2Assets({ head, list } as unknown as R2Bucket, 'project', new Set())).toEqual(
      new Map(),
    );
    expect(head).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('checks small deltas directly without listing unrelated retained objects', async () => {
    const object = { key: 'assets/project/present', size: 12 };
    const head = vi.fn(async (key: string) => (key === object.key ? object : null));
    const list = vi.fn();
    const found = await findR2Assets(
      { head, list } as unknown as R2Bucket,
      'project',
      new Set(['present', 'missing']),
    );
    expect(found).toEqual(new Map([['present', object]]));
    expect(head.mock.calls).toEqual([['assets/project/present'], ['assets/project/missing']]);
    expect(list).not.toHaveBeenCalled();
  });

  it('uses paginated inventory for large manifests and stops once all hashes are found', async () => {
    const hashes = Array.from({ length: 5000 }, (_, i) => String(i));
    const objects = hashes.map((hash) => ({ key: `assets/project/${hash}`, size: 10 }));
    const head = vi.fn();
    const list = vi.fn(async ({ cursor }: { cursor?: string }) => {
      const start = Number(cursor ?? 0);
      return {
        objects: objects.slice(start, start + 1000),
        truncated: true,
        cursor: String(start + 1000),
      };
    });
    const found = await findR2Assets(
      { head, list } as unknown as R2Bucket,
      'project',
      new Set(hashes),
    );
    expect(found.size).toBe(5000);
    expect(list).toHaveBeenCalledTimes(5);
    expect(head).not.toHaveBeenCalled();
  });

  it('does not treat an object-store error as a missing upload', async () => {
    const head = vi.fn().mockRejectedValue(new Error('unavailable'));
    await expect(
      findR2Assets({ head } as unknown as R2Bucket, 'project', new Set(['asset'])),
    ).rejects.toThrow('unavailable');
  });
});
