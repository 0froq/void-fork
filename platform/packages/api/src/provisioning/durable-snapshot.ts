export async function snapshotDigest(value: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = new Uint8Array(
    typeof value === 'string'
      ? new TextEncoder().encode(value)
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : value,
  );
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** Immutable release writes can be recovered after a lost R2 acknowledgement. */
export async function putDurableSnapshotObject(
  bucket: Pick<R2Bucket, 'put' | 'get'>,
  key: string,
  value: string | ArrayBuffer | Uint8Array,
  digest?: string,
): Promise<void> {
  const expected = digest ?? (await snapshotDigest(value));
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const written = await bucket.put(key, value, { onlyIf: { etagDoesNotMatch: '*' } });
      if (written) {
        return;
      }
    } catch (error) {
      failure = error;
    }
    // R2 reads are strongly consistent. Verify an acknowledged or ambiguous
    // write before accepting it; the condition also fences any late PUT.
    const stored = await bucket.get(key);
    if (stored) {
      if ((await snapshotDigest(await stored.arrayBuffer())) === expected) {
        return;
      }
      throw new Error(`Custom Durable Object release snapshot changed: ${key}`);
    }
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
    }
  }
  throw new Error(`Could not store custom Durable Object release snapshot: ${key}`, {
    cause: failure,
  });
}
