import { afterEach, expect, it, vi } from 'vite-plus/test';
import {
  putDurableSnapshotObject,
  snapshotDigest,
} from '../../src/provisioning/durable-snapshot.ts';
const value = new TextEncoder().encode('immutable release');
function fixture() {
  let stored: Uint8Array | undefined;
  const put = vi.fn(async (_key: string, bytes: Uint8Array) => {
    if (stored) {
      return null;
    }
    stored = bytes;
    return {};
  });
  const get = vi.fn(async () =>
    stored ? { arrayBuffer: async () => new Uint8Array(stored!).buffer } : null,
  );
  return {
    bucket: { put, get } as unknown as Pick<R2Bucket, 'put' | 'get'>,
    put,
    get,
    set: (bytes: Uint8Array) => {
      stored = bytes;
    },
  };
}
afterEach(() => vi.useRealTimers());

it('accepts a landed write whose acknowledgement was lost without writing it again', async () => {
  const f = fixture();
  f.put.mockImplementationOnce(async () => {
    f.set(value);
    throw Error('put: internal error (10001)');
  });
  await putDurableSnapshotObject(f.bucket, 'release/module.js', value);
  expect(f.put).toHaveBeenCalledOnce();
  expect(f.get).toHaveBeenCalledOnce();
  expect(f.put.mock.calls[0]).toEqual([
    'release/module.js',
    value,
    { onlyIf: { etagDoesNotMatch: '*' } },
  ]);
});

it('retries a failed write only after confirming that the object is absent', async () => {
  const digest = await snapshotDigest(value);
  vi.useFakeTimers();
  const f = fixture();
  f.put.mockRejectedValueOnce(Error('put: internal error (10001)'));
  const result = putDurableSnapshotObject(f.bucket, 'release/module.js', value, digest);
  await vi.advanceTimersByTimeAsync(200);
  await result;
  expect(f.put).toHaveBeenCalledTimes(2);
  expect(f.get).toHaveBeenCalledOnce();
});

it('rejects changed existing bytes and never overwrites them', async () => {
  const f = fixture();
  f.set(new TextEncoder().encode('other release'));
  await expect(putDurableSnapshotObject(f.bucket, 'release/module.js', value)).rejects.toThrow(
    'snapshot changed',
  );
  expect(f.put).toHaveBeenCalledOnce();
});

it('does not retry when inspection fails after an ambiguous write', async () => {
  const f = fixture();
  f.put.mockRejectedValueOnce(Error('put failed'));
  f.get.mockRejectedValueOnce(Error('read failed'));
  await expect(putDurableSnapshotObject(f.bucket, 'release/module.js', value)).rejects.toThrow(
    'read failed',
  );
  expect(f.put).toHaveBeenCalledOnce();
});

it('bounds persistent failures after three inspected attempts', async () => {
  const digest = await snapshotDigest(value);
  vi.useFakeTimers();
  const f = fixture();
  f.put.mockRejectedValue(Error('put failed'));
  const result = expect(
    putDurableSnapshotObject(f.bucket, 'release/module.js', value, digest),
  ).rejects.toThrow('Could not store');
  await vi.advanceTimersByTimeAsync(600);
  await result;
  expect(f.put).toHaveBeenCalledTimes(3);
  expect(f.get).toHaveBeenCalledTimes(3);
});

it('accepts an identical existing object after its conditional write is rejected', async () => {
  const f = fixture();
  f.set(value);
  await putDurableSnapshotObject(f.bucket, 'release/module.js', value);
  expect(f.put).toHaveBeenCalledOnce();
  expect(f.get).toHaveBeenCalledOnce();
});
