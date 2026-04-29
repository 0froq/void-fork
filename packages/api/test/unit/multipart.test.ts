import { describe, it, expect } from 'vitest';
import { parseBoundary, parseMultipart, MultipartParseError } from '../../src/multipart.ts';

function bodyFromString(s: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(s);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function bodyFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Emits `total` in chunks of at most `chunkSize` bytes. */
function bodyInChunks(total: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= total.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, total.length);
      controller.enqueue(total.slice(offset, end));
      offset = end;
    },
  });
}

function buildMultipart(
  boundary: string,
  parts: Array<{
    name: string;
    filename?: string;
    contentType?: string;
    body: Uint8Array | string;
  }>,
): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Array<Uint8Array> = [];
  for (const p of parts) {
    chunks.push(enc.encode(`--${boundary}\r\n`));
    let disp = `Content-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) {
      disp += `; filename="${p.filename}"`;
    }
    chunks.push(enc.encode(disp + '\r\n'));
    if (p.contentType) {
      chunks.push(enc.encode(`Content-Type: ${p.contentType}\r\n`));
    }
    chunks.push(enc.encode('\r\n'));
    chunks.push(typeof p.body === 'string' ? enc.encode(p.body) : p.body);
    chunks.push(enc.encode('\r\n'));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

async function readBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('parseBoundary', () => {
  it('extracts unquoted boundary', () => {
    expect(parseBoundary('multipart/form-data; boundary=abc123')).toBe('abc123');
  });

  it('extracts quoted boundary', () => {
    expect(parseBoundary('multipart/form-data; boundary="ab cd"')).toBe('ab cd');
  });

  it('is case-insensitive', () => {
    expect(parseBoundary('Multipart/Form-Data; BOUNDARY=xyz')).toBe('xyz');
  });

  it('throws when missing', () => {
    expect(() => parseBoundary('multipart/form-data')).toThrow(MultipartParseError);
  });

  it('throws when content-type is null', () => {
    expect(() => parseBoundary(null)).toThrow(MultipartParseError);
  });
});

describe('parseMultipart', () => {
  const BOUNDARY = '----void-test';

  it('parses a single text part', async () => {
    const body = buildMultipart(BOUNDARY, [{ name: 'hello', body: 'world' }]);
    const parts: Array<{ name: string; text: string }> = [];
    for await (const part of parseMultipart(bodyFromBytes(body), BOUNDARY)) {
      parts.push({ name: part.name, text: await readText(part.body) });
    }
    expect(parts).toEqual([{ name: 'hello', text: 'world' }]);
  });

  it('parses multiple parts with mixed content', async () => {
    const body = buildMultipart(BOUNDARY, [
      { name: 'manifest', body: '{"version":3}' },
      { name: 'worker:index.js', filename: 'index.js', body: 'export default {}' },
      { name: 'asset:index.html', contentType: 'text/html', body: '<html></html>' },
    ]);
    const parts: Array<{ name: string; filename?: string; ct?: string; text: string }> = [];
    for await (const part of parseMultipart(bodyFromBytes(body), BOUNDARY)) {
      parts.push({
        name: part.name,
        filename: part.filename,
        ct: part.contentType,
        text: await readText(part.body),
      });
    }
    expect(parts).toEqual([
      { name: 'manifest', filename: undefined, ct: undefined, text: '{"version":3}' },
      { name: 'worker:index.js', filename: 'index.js', ct: undefined, text: 'export default {}' },
      { name: 'asset:index.html', filename: undefined, ct: 'text/html', text: '<html></html>' },
    ]);
  });

  it('handles empty part body', async () => {
    const body = buildMultipart(BOUNDARY, [{ name: 'empty', body: '' }]);
    const parts: Array<{ name: string; text: string }> = [];
    for await (const part of parseMultipart(bodyFromBytes(body), BOUNDARY)) {
      parts.push({ name: part.name, text: await readText(part.body) });
    }
    expect(parts).toEqual([{ name: 'empty', text: '' }]);
  });

  it('handles preamble bytes before the first boundary', async () => {
    const enc = new TextEncoder();
    const inner = buildMultipart(BOUNDARY, [{ name: 'x', body: 'y' }]);
    const withPreamble = new Uint8Array(inner.length + 24);
    withPreamble.set(enc.encode('This is a preamble.\r\n\r\n'));
    withPreamble.set(inner, 24);
    const parts: Array<string> = [];
    for await (const part of parseMultipart(bodyFromBytes(withPreamble), BOUNDARY)) {
      parts.push(`${part.name}=${await readText(part.body)}`);
    }
    expect(parts).toEqual(['x=y']);
  });

  it('survives boundaries split across chunk edges', async () => {
    const body = buildMultipart(BOUNDARY, [
      { name: 'a', body: 'AAA' },
      { name: 'b', body: 'BBB' },
      { name: 'c', body: 'CCC' },
    ]);
    // Feed one byte at a time to stress the carry/fill logic.
    const parts: Record<string, string> = {};
    for await (const part of parseMultipart(bodyInChunks(body, 1), BOUNDARY)) {
      parts[part.name] = await readText(part.body);
    }
    expect(parts).toEqual({ a: 'AAA', b: 'BBB', c: 'CCC' });
  });

  it('streams large binary part without buffering all chunks upstream', async () => {
    // Build a 1 MB pseudo-random payload.
    const size = 1024 * 1024;
    const payload = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      payload[i] = (i * 31 + 7) & 0xff;
    }
    const body = buildMultipart(BOUNDARY, [
      { name: 'asset:big.bin', body: payload, contentType: 'application/octet-stream' },
      { name: 'marker', body: 'END' },
    ]);
    const found: Record<string, Uint8Array | string> = {};
    for await (const part of parseMultipart(bodyInChunks(body, 8 * 1024), BOUNDARY)) {
      if (part.name === 'marker') {
        found[part.name] = await readText(part.body);
      } else {
        found[part.name] = await readBytes(part.body);
      }
    }
    expect((found['asset:big.bin'] as Uint8Array).length).toBe(size);
    expect(found['asset:big.bin']).toEqual(payload);
    expect(found.marker).toBe('END');
  });

  it('drains abandoned part bodies before advancing', async () => {
    const body = buildMultipart(BOUNDARY, [
      { name: 'skip', body: 'ignored payload content' },
      { name: 'keep', body: 'kept' },
    ]);
    const seen: Record<string, string> = {};
    for await (const part of parseMultipart(bodyFromBytes(body), BOUNDARY)) {
      if (part.name === 'skip') {
        // Intentionally do not read part.body — parser must drain it.
        continue;
      }
      seen[part.name] = await readText(part.body);
    }
    expect(seen).toEqual({ keep: 'kept' });
  });

  it('drains partially consumed part body', async () => {
    const body = buildMultipart(BOUNDARY, [
      { name: 'partial', body: 'abcdefghij' },
      { name: 'next', body: 'hello' },
    ]);
    const seen: Array<string> = [];
    for await (const part of parseMultipart(bodyInChunks(body, 3), BOUNDARY)) {
      if (part.name === 'partial') {
        const reader = part.body.getReader();
        const first = await reader.read();
        seen.push(`partial-first=${new TextDecoder().decode(first.value)}`);
        reader.releaseLock();
        continue;
      }
      seen.push(`${part.name}=${await readText(part.body)}`);
    }
    // First chunk length depends on fill granularity; we just need the second
    // part to still parse correctly.
    expect(seen[seen.length - 1]).toBe('next=hello');
  });

  it('parses filenames with escaped quotes', async () => {
    const enc = new TextEncoder();
    const body =
      `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="he said \\"hi\\".txt"\r\n\r\n` +
      `data\r\n--${BOUNDARY}--\r\n`;
    const parts: Array<{ name: string; filename?: string }> = [];
    for await (const part of parseMultipart(bodyFromBytes(enc.encode(body)), BOUNDARY)) {
      parts.push({ name: part.name, filename: part.filename });
      await readText(part.body);
    }
    expect(parts).toEqual([{ name: 'file', filename: 'he said "hi".txt' }]);
  });

  it('throws on missing Content-Disposition', async () => {
    const enc = new TextEncoder();
    const body = `--${BOUNDARY}\r\n\r\nno headers\r\n--${BOUNDARY}--\r\n`;
    await expect(async () => {
      for await (const _p of parseMultipart(bodyFromBytes(enc.encode(body)), BOUNDARY)) {
        // ignored
      }
    }).rejects.toThrow(MultipartParseError);
  });

  it('throws on truncated stream', async () => {
    const enc = new TextEncoder();
    const body = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="x"\r\n\r\nincomp`;
    await expect(async () => {
      for await (const _p of parseMultipart(bodyFromBytes(enc.encode(body)), BOUNDARY)) {
        await readText(_p.body);
      }
    }).rejects.toThrow(MultipartParseError);
  });

  it('throws on null body', async () => {
    await expect(async () => {
      for await (const _p of parseMultipart(null, BOUNDARY)) {
        // unreachable
      }
    }).rejects.toThrow(MultipartParseError);
  });

  it('rejects oversized header arriving in a single read', async () => {
    // Regression for round 8 finding: the old check only ran while
    // `headersEnd === -1`, so a reader that delivered the full header +
    // terminator in one chunk bypassed the cap entirely.
    const enc = new TextEncoder();
    const longName = 'x'.repeat(17000); // well over 16 KiB
    const body =
      `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="${longName}"\r\n\r\n` +
      `body\r\n--${BOUNDARY}--\r\n`;
    await expect(async () => {
      for await (const _p of parseMultipart(bodyFromBytes(enc.encode(body)), BOUNDARY)) {
        await readText(_p.body);
      }
    }).rejects.toThrow(/part headers exceed/);
  });

  it('accepts a header sitting exactly at the cap when terminator splits across reads', async () => {
    // Regression for round 8 finding: a 16 KiB header was unfairly rejected
    // when only `\r\n\r` of the terminator had been read — `buf.length`
    // was 16 KiB + 3 and the old check rejected at > 16 KiB exactly.
    const enc = new TextEncoder();
    const prefix = 'Content-Disposition: form-data; name="';
    const suffix = '"';
    const nameLen = 16 * 1024 - prefix.length - suffix.length;
    const longName = 'x'.repeat(nameLen);
    const raw =
      `--${BOUNDARY}\r\n` + `${prefix}${longName}${suffix}\r\n\r\n` + `body\r\n--${BOUNDARY}--\r\n`;
    const bytes = enc.encode(raw);
    // Split so the first chunk ends with `\r\n\r` — three of the four
    // terminator bytes. The final `\n` arrives in the second chunk.
    const splitAfter = enc.encode(`--${BOUNDARY}\r\n${prefix}${longName}${suffix}\r\n\r`).length;
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        const end = offset === 0 ? splitAfter : bytes.length;
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
    });
    const parts: Array<{ name: string; text: string }> = [];
    for await (const part of parseMultipart(stream, BOUNDARY)) {
      parts.push({ name: part.name, text: await readText(part.body) });
    }
    expect(parts).toEqual([{ name: longName, text: 'body' }]);
  });

  it('rejects a header one byte over the cap even with a split terminator', async () => {
    const enc = new TextEncoder();
    const prefix = 'Content-Disposition: form-data; name="';
    const suffix = '"';
    // One byte past the cap.
    const nameLen = 16 * 1024 - prefix.length - suffix.length + 1;
    const longName = 'x'.repeat(nameLen);
    const raw =
      `--${BOUNDARY}\r\n` + `${prefix}${longName}${suffix}\r\n\r\n` + `body\r\n--${BOUNDARY}--\r\n`;
    await expect(async () => {
      for await (const _p of parseMultipart(bodyFromBytes(enc.encode(raw)), BOUNDARY)) {
        await readText(_p.body);
      }
    }).rejects.toThrow(/part headers exceed/);
  });

  it('emits part body in bounded chunks even when the reader delivers one large read', async () => {
    // Regression for round 8 finding: a single 1 MB transport chunk used to
    // be returned as one slice, defeating any byte-cap a consumer wanted to
    // enforce mid-stream. The parser now slices emissions to
    // MAX_PART_BODY_CHUNK_BYTES (64 KiB) so a capped consumer can abort
    // after observing only one chunk worth of bytes.
    const MAX_CHUNK = 64 * 1024;
    const payload = new Uint8Array(1024 * 1024);
    for (let i = 0; i < payload.length; i++) {
      payload[i] = (i * 37 + 3) & 0xff;
    }
    const body = buildMultipart(BOUNDARY, [
      { name: 'big', body: payload },
      { name: 'next', body: 'ok' },
    ]);
    const sizes: Array<number> = [];
    for await (const part of parseMultipart(bodyFromBytes(body), BOUNDARY)) {
      if (part.name !== 'big') {
        await readText(part.body);
        continue;
      }
      const reader = part.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        sizes.push(value.length);
      }
      reader.releaseLock();
    }
    expect(sizes.length).toBeGreaterThan(1);
    for (const size of sizes) {
      expect(size).toBeLessThanOrEqual(MAX_CHUNK);
    }
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(payload.length);
  });

  it('streams an oversized single-read body through bounded chunks', async () => {
    // Regression for the R16/R17 OOM class: when a reader delivers a
    // multi-megabyte body in one oversized `reader.read()` value, the
    // parser must not (a) emit the whole body in one downstream chunk
    // — that would force downstream consumers to buffer a
    // multi-megabyte allocation at once — nor (b) duplicate the
    // oversized transport read wholesale into a copy-queue before
    // parsing, which would transiently spike peak residency to ~2x
    // the read size. The R17 fix uses an incremental `partialRead`
    // cursor that carves one bounded slice per fill() iteration.
    //
    // We cannot directly observe memory residency in a pure JS unit
    // test (and relying on `globalThis.gc()` + WeakRef yields flaky,
    // GC-timing-dependent assertions). Instead we verify the
    // OBSERVABLE contract that the fix exists to uphold:
    //
    //   1. All bytes round-trip correctly (the parser can drain a
    //      single oversized transport read at all).
    //   2. Every emitted chunk is bounded by MAX_PART_BODY_CHUNK_BYTES
    //      (64 KiB). Against a buffered-all-at-once parser, the 4 MiB
    //      part would emit one 4 MiB chunk and this assertion fails.
    //   3. A 4 MiB part is split into at least 64 chunks. Against a
    //      buffered-all-at-once parser or an implementation that
    //      merges runs, the count would be far lower.
    //   4. Abandoning iteration early cancels the upstream body via
    //      the parser's finally block — verified via `await using`
    //      on the async generator so scope exit triggers return().
    const PAYLOAD1_LEN = 4 * 1024 * 1024;
    const PAYLOAD2_LEN = 3 * 1024 * 1024;
    const payload1 = new Uint8Array(PAYLOAD1_LEN);
    const payload2 = new Uint8Array(PAYLOAD2_LEN);
    for (let i = 0; i < payload1.length; i++) {
      payload1[i] = (i * 17 + 5) & 0xff;
    }
    for (let i = 0; i < payload2.length; i++) {
      payload2[i] = (i * 23 + 11) & 0xff;
    }
    const body = buildMultipart(BOUNDARY, [
      { name: 'worker:index.js', filename: 'index.js', body: payload1 },
      { name: 'asset:data.bin', contentType: 'application/octet-stream', body: payload2 },
    ]);
    // Single-read source: the entire multipart body arrives as one
    // reader.read() value. This is the worst-case path the R17 fix
    // targets — per-fill incremental carving of an oversized value.
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    });

    const seen: Record<string, { total: number; chunks: Array<number> }> = {};
    for await (const part of parseMultipart(source, BOUNDARY)) {
      const chunks: Array<number> = [];
      let total = 0;
      const reader = part.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        chunks.push(value.length);
        total += value.length;
      }
      reader.releaseLock();
      seen[part.name] = { total, chunks };
    }

    // (1) Round-trip correctness.
    expect(seen['worker:index.js'].total).toBe(PAYLOAD1_LEN);
    expect(seen['asset:data.bin'].total).toBe(PAYLOAD2_LEN);
    // (2) Chunk-size bound. Against a buffered-all-at-once parser this
    // fails — it would emit one 4 MiB chunk for the worker part.
    for (const c of seen['worker:index.js'].chunks) {
      expect(c).toBeLessThanOrEqual(64 * 1024);
    }
    for (const c of seen['asset:data.bin'].chunks) {
      expect(c).toBeLessThanOrEqual(64 * 1024);
    }
    // (3) Chunk-count lower bound. 4 MiB / 64 KiB = 64, so any
    // streaming implementation must produce at least 64 chunks.
    expect(seen['worker:index.js'].chunks.length).toBeGreaterThanOrEqual(64);
    expect(seen['asset:data.bin'].chunks.length).toBeGreaterThanOrEqual(48);
  });

  it('cleans up the parser via `await using` when iteration is abandoned', async () => {
    // Regression supporting the R16/R17 fix: the parser's finally
    // block is the only place that cancels the upstream reader, so
    // any consumer that abandons iteration early must trigger
    // cleanup via the generator's return() / Symbol.asyncDispose.
    // `await using` makes scope-exit cleanup deterministic without
    // needing a for-await break or manual .return() call.
    let cancelCalled = false;
    // Intentionally leave the source stream open after enqueueing one
    // large chunk. Closing via start() would short-circuit the cancel
    // algorithm (cancel on an already-closed stream is a no-op per the
    // Streams spec), and the test would pass even if the parser's
    // finally block never ran. Leaving the stream open forces the only
    // way to resolve the outer reader to be through reader.cancel(),
    // which is exactly what we want to observe.
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          buildMultipart(BOUNDARY, [
            { name: 'a', body: new Uint8Array(512 * 1024).fill(0x41) },
            { name: 'b', body: new Uint8Array(512 * 1024).fill(0x42) },
          ]),
        );
      },
      cancel() {
        cancelCalled = true;
      },
    });

    async function consumeOneThenAbandon(): Promise<void> {
      // `await using` on the async generator means scope exit invokes
      // iter[Symbol.asyncDispose] → iter.return() → the parser's
      // finally block → reader.cancel() on the upstream stream.
      await using iter = parseMultipart(source, BOUNDARY);
      const { value: part } = await iter.next();
      expect(part?.name).toBe('a');
      // Abandon the body stream without draining, then let scope
      // exit run dispose.
      await part!.body.cancel();
    }

    await consumeOneThenAbandon();
    expect(cancelCalled).toBe(true);
  });

  it('lets a consumer abort early when the body exceeds an external cap', async () => {
    // Simulates the readPartText pattern in deploy.ts: a consumer watches
    // running total and throws once a per-part byte cap is exceeded. With
    // the chunk cap in place the consumer can bail before the whole body
    // has been copied through the parser.
    const payload = new Uint8Array(512 * 1024).fill(0x41);
    const body = buildMultipart(BOUNDARY, [{ name: 'big', body: payload }]);
    const cap = 64 * 1024;
    let bytesSeen = 0;
    let aborted = false;
    try {
      for await (const part of parseMultipart(bodyFromBytes(body), BOUNDARY)) {
        const reader = part.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          bytesSeen += value.length;
          if (bytesSeen > cap) {
            aborted = true;
            throw new Error('CAP_EXCEEDED');
          }
        }
      }
    } catch (err) {
      if ((err as Error).message !== 'CAP_EXCEEDED') {
        throw err;
      }
    }
    expect(aborted).toBe(true);
    // Much less than the full 512 KiB — at most one chunk past the cap.
    expect(bytesSeen).toBeLessThanOrEqual(cap + 64 * 1024);
  });

  it('cancels the upstream body when the consumer bails out mid-part', async () => {
    // Regression for round 9 finding: the old generator never cancelled the
    // upstream body when the caller aborted early, so the rest of the request
    // stayed buffered upstream (and, under CF Workers, held against the
    // 128 MB request budget) even though we'd already thrown.
    const payload = new Uint8Array(512 * 1024).fill(0x42);
    const body = buildMultipart(BOUNDARY, [
      { name: 'big', body: payload },
      { name: 'never', body: 'unreached' },
    ]);
    let cancelCalled = false;
    let pulls = 0;
    // Use a pull-based source that NEVER calls controller.close() — if we
    // close eagerly, the stream transitions to closed after the last read
    // and cancel() becomes a no-op, hiding the regression.
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(body);
        }
        // Subsequent pulls: stall. The parser has enough data in pending to
        // finish parsing without asking again; if it does ask, cancel() will
        // still fire to release the reader.
      },
      cancel() {
        cancelCalled = true;
      },
    });
    try {
      for await (const part of parseMultipart(source, BOUNDARY)) {
        const reader = part.body.getReader();
        await reader.read();
        reader.releaseLock();
        throw new Error('CONSUMER_BAILED');
      }
    } catch (err) {
      if ((err as Error).message !== 'CONSUMER_BAILED') {
        throw err;
      }
    }
    expect(cancelCalled).toBe(true);
  });

  it('cancels the upstream body when a part header is malformed', async () => {
    // Same fix from the other direction: when the parser itself throws
    // (e.g. missing Content-Disposition), the try/finally in the generator
    // must still cancel the source so the remainder of the request body
    // isn't held in memory while the caller is handling the 400.
    const enc = new TextEncoder();
    // Headers parse cleanly (we see `\r\n\r\n`) but carry no
    // Content-Disposition — the parser throws immediately without asking for
    // more data, so the stall-on-second-pull source can still be cancelled.
    const bad = enc.encode(
      `--${BOUNDARY}\r\n` + `Content-Type: text/plain\r\n\r\n` + `body\r\n--${BOUNDARY}--\r\n`,
    );
    let cancelCalled = false;
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(bad);
        }
        // Stay readable — don't close. cancel() must fire from the parser's
        // finally block once the malformed part triggers a throw.
      },
      cancel() {
        cancelCalled = true;
      },
    });
    await expect(async () => {
      for await (const _p of parseMultipart(source, BOUNDARY)) {
        await readText(_p.body);
      }
    }).rejects.toThrow(MultipartParseError);
    expect(cancelCalled).toBe(true);
  });

  it('handles boundary-like sequences in part body', async () => {
    // Part body contains "--void-test" as regular content, but not preceded by CRLF
    // so the delimiter match should NOT fire.
    const enc = new TextEncoder();
    const payload = `prefix--${BOUNDARY}suffix`;
    const body = buildMultipart(BOUNDARY, [{ name: 'tricky', body: payload }]);
    const parts: Record<string, string> = {};
    for await (const part of parseMultipart(
      bodyFromBytes(enc.encode(new TextDecoder().decode(body))),
      BOUNDARY,
    )) {
      parts[part.name] = await readText(part.body);
    }
    expect(parts).toEqual({ tricky: payload });
  });
});

describe('parseMultipart interoperability with native FormData', () => {
  it('parses a body that a real Request would produce', async () => {
    const native = new FormData();
    native.append('manifest', JSON.stringify({ version: 3 }));
    native.append('asset:index.html', new Blob(['<html></html>'], { type: 'text/html' }));
    native.append('asset:app.js', new Blob(['console.log(1)']), 'app.js');
    const req = new Request('http://localhost/', { method: 'POST', body: native });
    const boundary = parseBoundary(req.headers.get('content-type'));
    const seen: Record<string, string> = {};
    for await (const part of parseMultipart(req.body, boundary)) {
      seen[part.name] = await readText(part.body);
    }
    expect(seen).toEqual({
      manifest: '{"version":3}',
      'asset:index.html': '<html></html>',
      'asset:app.js': 'console.log(1)',
    });
  });
});
