/**
 * Streaming multipart/form-data parser for CF Workers.
 *
 * Yields each part with a ReadableStream body so large asset uploads can be
 * piped through without buffering the entire request. Designed for the deploy
 * endpoint, which receives `manifest`, `worker:*`, `asset:*`, and `migration:*`
 * parts plus a few small text fields.
 *
 * Usage:
 *
 *   for await (const part of parseMultipart(req.body, boundary)) {
 *     // Consume part.body (ReadableStream) OR abandon it — the parser will
 *     // drain and discard any unread bytes before advancing to the next part.
 *   }
 *
 * Caveats:
 *   - Content-Transfer-Encoding is ignored (not used by deploy clients).
 *   - Header lines must be ASCII (we only read Content-Disposition and Content-Type).
 *   - The caller MUST fully consume one part before reading the next; interleaving
 *     reads across parts would race on the shared buffer.
 */

export interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  /** Body stream for this part. Must be drained (or abandoned) before the next part is requested. */
  body: ReadableStream<Uint8Array>;
}

export class MultipartParseError extends Error {
  constructor(message: string) {
    super(`multipart parse error: ${message}`);
  }
}

/**
 * Thrown when a multipart part exceeds its per-part byte cap. Raised by
 * stream-reading helpers (e.g. `readPartText` in routes/deploy.ts, asset
 * body readers in assets.ts) the instant the cumulative byte total crosses
 * the cap, so no oversized input is ever materialized into a single buffer.
 * The outer deploy handler maps this to HTTP 413.
 */
export class PartTooLargeError extends Error {
  constructor(
    public readonly partName: string,
    public readonly limitBytes: number,
  ) {
    super(`${partName} part exceeds ${limitBytes} byte limit`);
  }
}

export function parseBoundary(contentType: string | null | undefined): string {
  if (!contentType) {
    throw new MultipartParseError('missing Content-Type header');
  }
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!match) {
    throw new MultipartParseError('missing boundary in Content-Type');
  }
  return match[1] ?? match[2];
}

const CR = 0x0d;
const LF = 0x0a;
const DASH = 0x2d;

// Cap per-part header buffering so a client that never sends `\r\n\r\n`
// cannot force us to grow the internal buffer without bound. 16 KiB is
// orders of magnitude larger than any legitimate Content-Disposition +
// Content-Type pair.
const MAX_PART_HEADER_BYTES = 16 * 1024;

// Cap the size of each chunk emitted from a part body stream. If a reader
// read() returns a large chunk, we slice it into bounded pieces so a
// capped consumer (e.g. readPartText in deploy.ts) can observe its running
// total and abort before buffering a multi-megabyte text part.
const MAX_PART_BODY_CHUNK_BYTES = 64 * 1024;

// Cap how many bytes from an underlying reader.read() we copy into the
// working buffer per fill() iteration. Leftover bytes stay behind in the
// pending queue so a single huge transport chunk cannot force `buf` to
// balloon to the size of the whole chunk.
const MAX_FILL_GROWTH_BYTES = 64 * 1024;

// Cap the size of any single reader.read() value we retain zero-copy
// between fill() iterations. Reads at or under this cap go on the fast
// path (pushed as-is into pendingQueue — a subarray leftover can only
// pin a bounded ArrayBuffer). Reads larger than this cap fall into the
// incremental-copy path: the oversized value is parked in `partialRead`
// and one bounded slice is copied out per fill() iteration. This avoids
// ever allocating all copies of the oversized value simultaneously (the
// "eager-copy" spike that would momentarily double the original read
// size), while also ensuring the original transport ArrayBuffer gets
// released as soon as its last byte has been copied out — no long-lived
// subarray view pinning the backing buffer past the point of last use.
const MAX_PENDING_RETENTION_BYTES = 1024 * 1024;

function indexOf(haystack: Uint8Array, needle: Uint8Array, start: number): number {
  const limit = haystack.length - needle.length;
  outer: for (let i = start; i <= limit; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}

function decodeAscii(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes);
}

function parseHeaders(raw: Uint8Array): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of decodeAscii(raw).split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) {
      continue;
    }
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return headers;
}

function parseContentDisposition(value: string): { name?: string; filename?: string } {
  const result: { name?: string; filename?: string } = {};
  const re = /(\w+)=(?:"((?:\\.|[^"\\])*)"|([^;]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const key = m[1].toLowerCase();
    const raw = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3].trim();
    if (key === 'name') {
      result.name = raw;
    } else if (key === 'filename') {
      result.filename = raw;
    }
  }
  return result;
}

export async function* parseMultipart(
  body: ReadableStream<Uint8Array> | null,
  boundary: string,
): AsyncGenerator<MultipartPart> {
  if (!body) {
    throw new MultipartParseError('request body is missing');
  }

  const encoder = new TextEncoder();
  const dashBoundary = encoder.encode(`--${boundary}`);
  // Delimiter between parts: CRLF + "--" + boundary. The leading CRLF belongs
  // to the previous part's terminator, not the part body.
  const delimiter = encoder.encode(`\r\n--${boundary}`);
  const headerTerminator = encoder.encode('\r\n\r\n');

  const reader = body.getReader();
  let buf = new Uint8Array(0);
  // FIFO of bytes waiting to be copied into `buf`. Each entry is either a
  // zero-copy retained small read (≤ MAX_PENDING_RETENTION_BYTES) or a
  // bounded copy that we carved out of an oversized read (via
  // `partialRead` below). The queue is bounded in length at all times:
  // the drain-first / carve-second / read-third structure of fill()
  // guarantees it never grows past one entry before being partially
  // consumed.
  const pendingQueue: Array<Uint8Array> = [];
  // When a single reader.read() value exceeds MAX_PENDING_RETENTION_BYTES
  // we cannot queue it zero-copy (a subarray leftover of even one byte
  // would pin the full backing ArrayBuffer alive against the 128 MiB
  // Worker request budget) and we also refuse to eagerly copy the whole
  // thing at once (that would allocate a second full-size copy while the
  // original is still in scope — a transient 2x spike that itself
  // threatens the budget). Instead we park the oversized value here and
  // copy out one bounded slice per fill() iteration via the incremental
  // carve step. `partialRead` is cleared — releasing the original
  // ArrayBuffer — the moment its last byte has been copied out.
  let partialRead: { buffer: Uint8Array; offset: number } | null = null;
  let eof = false;

  async function fill(minBytes: number): Promise<void> {
    while (buf.length < minBytes && !eof) {
      // Step 1: if the queue already has bytes, drain one bounded piece
      // into buf. Leftover stays in the head via subarray — safe because
      // every queue entry is bounded to MAX_PENDING_RETENTION_BYTES.
      if (pendingQueue.length > 0) {
        const head = pendingQueue[0]!;
        const take = Math.min(head.length, MAX_FILL_GROWTH_BYTES);
        const next = new Uint8Array(buf.length + take);
        next.set(buf);
        next.set(head.subarray(0, take), buf.length);
        buf = next;
        if (take < head.length) {
          pendingQueue[0] = head.subarray(take);
        } else {
          pendingQueue.shift();
        }
        continue;
      }
      // Step 2: if we are mid-draining an oversized read, carve exactly
      // ONE bounded copied slice off the front of `partialRead` into the
      // queue, advance the cursor, and loop. This bounds the transient
      // "duplicated" bytes to a single slice (≤ MAX_PENDING_RETENTION_BYTES)
      // instead of the whole oversized read, so the peak live set while
      // draining a large single read is roughly 1x its size rather than
      // 2x. When the cursor reaches the end, drop `partialRead` so the
      // underlying ArrayBuffer becomes GC-eligible immediately.
      if (partialRead) {
        const end = Math.min(
          partialRead.offset + MAX_PENDING_RETENTION_BYTES,
          partialRead.buffer.length,
        );
        pendingQueue.push(partialRead.buffer.slice(partialRead.offset, end));
        if (end >= partialRead.buffer.length) {
          partialRead = null;
        } else {
          partialRead.offset = end;
        }
        continue;
      }
      // Step 3: pull the next transport read. Small reads go on the
      // fast path (zero-copy retained in the queue). Oversized reads
      // are parked in `partialRead` for incremental carving above.
      const { value, done } = await reader.read();
      if (done) {
        eof = true;
        return;
      }
      if (value.length === 0) {
        continue;
      }
      if (value.length <= MAX_PENDING_RETENTION_BYTES) {
        pendingQueue.push(value);
      } else {
        partialRead = { buffer: value, offset: 0 };
      }
    }
  }

  function advance(n: number): void {
    buf = buf.slice(n);
  }

  try {
    // Skip preamble and find the opening boundary marker.
    while (true) {
      const idx = indexOf(buf, dashBoundary, 0);
      if (idx !== -1) {
        advance(idx + dashBoundary.length);
        break;
      }
      if (eof) {
        throw new MultipartParseError('no initial boundary found');
      }
      // Preserve the tail in case it contains the start of the boundary.
      const keep = Math.max(0, buf.length - (dashBoundary.length - 1));
      buf = buf.slice(keep);
      await fill(dashBoundary.length * 2);
    }

    while (true) {
      // After a boundary marker we expect either "--" (terminal) or CRLF.
      await fill(2);
      if (buf.length < 2) {
        throw new MultipartParseError('unexpected end after boundary');
      }
      if (buf[0] === DASH && buf[1] === DASH) {
        return;
      }
      // Skip any linear whitespace before CRLF.
      let skip = 0;
      while (skip < buf.length && (buf[skip] === 0x20 || buf[skip] === 0x09)) {
        skip++;
      }
      await fill(skip + 2);
      if (buf.length < skip + 2 || buf[skip] !== CR || buf[skip + 1] !== LF) {
        throw new MultipartParseError('missing CRLF after boundary');
      }
      advance(skip + 2);

      // Read headers until the blank line. Bounded by MAX_PART_HEADER_BYTES so
      // a missing `\r\n\r\n` cannot grow `buf` without bound. The cap is
      // enforced on the header length itself: when the terminator is found we
      // check `headersEnd` directly (so a single large read containing both
      // header and terminator can't bypass the cap), and while still searching
      // we allow `headerTerminator.length - 1` extra bytes so a header sitting
      // right at the cap isn't unfairly rejected when the terminator arrives
      // split across reads.
      let headersEnd = -1;
      while (headersEnd === -1) {
        headersEnd = indexOf(buf, headerTerminator, 0);
        if (headersEnd !== -1) {
          if (headersEnd > MAX_PART_HEADER_BYTES) {
            throw new MultipartParseError(`part headers exceed ${MAX_PART_HEADER_BYTES} bytes`);
          }
          break;
        }
        if (buf.length > MAX_PART_HEADER_BYTES + headerTerminator.length - 1) {
          throw new MultipartParseError(`part headers exceed ${MAX_PART_HEADER_BYTES} bytes`);
        }
        if (eof) {
          throw new MultipartParseError('end of stream while reading part headers');
        }
        await fill(buf.length + 1024);
      }
      const headersRaw = buf.slice(0, headersEnd);
      advance(headersEnd + headerTerminator.length);

      const headers = parseHeaders(headersRaw);
      const cd = headers.get('content-disposition');
      if (!cd) {
        throw new MultipartParseError('part missing Content-Disposition');
      }
      const { name, filename } = parseContentDisposition(cd);
      if (!name) {
        throw new MultipartParseError('part missing Content-Disposition name');
      }
      const contentType = headers.get('content-type');

      // Pull one chunk of part body up to the next delimiter. Returns null when
      // the delimiter is consumed (part is finished). Returns a zero-length
      // chunk when more bytes are needed from the reader. Emitted chunks are
      // bounded by MAX_PART_BODY_CHUNK_BYTES so a capped consumer of a text
      // part (e.g. readPartText) can observe its running total and abort
      // before copying a multi-megabyte body that arrived in one reader read.
      let partDone = false;
      const pullOnce = async (): Promise<Uint8Array | null> => {
        if (partDone) {
          return null;
        }
        await fill(delimiter.length + 1);
        const delimIdx = indexOf(buf, delimiter, 0);
        if (delimIdx !== -1) {
          // Delimiter is far enough into buf that we should emit in bounded
          // pieces first. Leaves the remaining body + delimiter in buf for
          // subsequent pullOnce() calls.
          if (delimIdx > MAX_PART_BODY_CHUNK_BYTES) {
            const chunk = buf.slice(0, MAX_PART_BODY_CHUNK_BYTES);
            advance(MAX_PART_BODY_CHUNK_BYTES);
            return chunk;
          }
          const chunk = buf.slice(0, delimIdx);
          advance(delimIdx + delimiter.length);
          partDone = true;
          return chunk.length > 0 ? chunk : null;
        }
        if (eof) {
          throw new MultipartParseError('end of stream while reading part body');
        }
        // Hold back (delimiter.length - 1) trailing bytes — they might be the
        // start of a delimiter split across chunks.
        const safe = Math.min(buf.length - (delimiter.length - 1), MAX_PART_BODY_CHUNK_BYTES);
        if (safe <= 0) {
          return new Uint8Array(0);
        }
        const chunk = buf.slice(0, safe);
        advance(safe);
        return chunk;
      };

      const partBody = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            while (true) {
              const chunk = await pullOnce();
              if (chunk === null) {
                controller.close();
                return;
              }
              if (chunk.length > 0) {
                controller.enqueue(chunk);
                return;
              }
            }
          } catch (err) {
            controller.error(err);
          }
        },
      });

      yield { name, filename, contentType, body: partBody };

      // If the caller abandoned the part body (or consumed it partially), drain
      // the remainder via pullOnce so the outer loop resumes at the next
      // delimiter. Safe because JS runs sequentially: the caller is awaiting
      // next() while we run here, so no concurrent pull is in flight.
      while (!partDone) {
        const chunk = await pullOnce();
        if (chunk === null) {
          break;
        }
      }
    }
  } finally {
    // Release the upstream request body when the consumer aborts early
    // (for-await break / throw / return) or when the generator finishes.
    // cancel() both stops the upstream source and, on a closed stream, is a
    // no-op — safe in all exit paths. Swallow any error so cleanup cannot
    // mask the real throw that triggered it.
    try {
      await reader.cancel();
    } catch {
      // Best-effort cleanup; the original exception (if any) still propagates.
    }
  }
}
