#!/usr/bin/env node
// @ts-check
/**
 * Build agent for "Deploy on GitHub".
 *
 * Runs inside the Cloudflare Container managed by the BuildManager Durable
 * Object (packages/api/src/build-manager.ts). It is intentionally THIN: it does
 * not re-implement deploy packaging. It downloads the pushed source, installs
 * the repo's dependencies, and runs the REAL `void deploy` CLI, which performs
 * all build + upload work using the short-lived scoped VOID_TOKEN.
 *
 * Contract with the DO (env vars the DO injects at start()):
 *   BUILD_ID            build row id (logging only)
 *   PROJECT_ID          project id (logging only)
 *   PROJECT_SLUG        project slug
 *   SOURCE_TARBALL_URL  GitHub source tarball (codeload) URL
 *   SOURCE_TOKEN        GitHub installation token (Bearer) to fetch the tarball
 *   VOID_TOKEN          project-scoped deploy JWT (consumed by `void deploy`).
 *                       Scrubbed from the install + any untrusted child env and
 *                       re-injected ONLY for the trusted `void deploy` spawn.
 *   VOID_API_URL        https://api.void.cloud (or staging)
 *   VOID_PROJECT        project slug passed to `void deploy --project`
 *   CF_ACCESS_CLIENT_ID     staging CF Access service-token id (staging builds
 *   CF_ACCESS_CLIENT_SECRET only). Like VOID_TOKEN: scrubbed from untrusted
 *                       children and re-injected ONLY for the `void deploy` spawn
 *                       so it can pass CF Access on the staging API host.
 *   DO_LOG_URL          full URL of the DO's log sink, e.g. https://manager/logs
 *   AGENT_TOKEN         per-build secret presented on this agent's DO control
 *                       POSTs (/logs, /status, /cancel). NEVER forwarded into
 *                       untrusted repo child processes (see `sanitizeChildEnv`).
 *
 * DO endpoints (see build-manager.ts `fetch`):
 *   POST /logs    body: Array<{ line, stream, ts }>
 *   POST /status  body: { status }
 *   POST /cancel  (DO -> agent; handled by this server)
 *   GET  /        (DO -> agent; health check)
 *
 * Transport note: the DO talks to the container over the Container model. The
 * agent talks back to the DO by POSTing to DO_LOG_URL (resolved via the
 * Container outbound-interception chain). ALL DO writes here are best-effort —
 * a transport failure must never abort the build. Logs are also retained
 * in-process and exposed at `GET /logs?since=<seq>` so the DO can PULL them if
 * push transport is unavailable (see open questions in the PR).
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { argv } from 'node:process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

// --- constants ---------------------------------------------------------------

const PORT = 4000;
const WORK_DIR = '/tmp/build/src';
const LOG_FLUSH_MS = 500;
// Hard timeout on each best-effort DO POST. Without it a hung DO connection would
// stall the single-flight log flush forever (logging would silently stop for the
// rest of the build); with it the flush retries on the next tick. Also bounds how
// long the final drain at exit can block before the container terminates.
const DO_POST_TIMEOUT_MS = 10000;
// Default pin kept in sync with the platform's shipped Void CLI. BuildManager
// injects VOID_CLI_VERSION; this constant is the backstop if the env is absent.
const DEFAULT_VOID_CLI_VERSION = '0.9.1';

// --- non-root build isolation ------------------------------------------------

/**
 * uid/gid the untrusted build children (dependency install + `void deploy`) run
 * under. The agent itself stays root so it can setuid-spawn them; dropping the
 * children to a non-root uid means their `/proc/<ppid>/environ` read of the root
 * agent is denied by the kernel (cross-uid), closing the secret-recovery vector
 * `delete process.env.*` cannot (unsetenv leaves the initial-stack env block in
 * /proc intact). MUST match the `builder` user created in the Dockerfile.
 */
export const BUILDER_UID = 1000;
export const BUILDER_GID = 1000;
export const BUILDER_HOME = '/home/builder';

/**
 * Cache/HOME overrides for the non-root builder. corepack, npm, yarn, and bun
 * all write under $HOME / $XDG_CACHE_HOME; the image's default env points some of
 * these at root-owned paths (e.g. BUN_INSTALL=/usr/local), so an unprivileged
 * install would EPERM without these. Merged into every untrusted child's env;
 * the Dockerfile pre-creates + chowns the matching dirs.
 * @returns {Record<string, string>}
 */
export function builderCacheEnv() {
  return {
    HOME: BUILDER_HOME,
    XDG_CACHE_HOME: `${BUILDER_HOME}/.cache`,
    npm_config_cache: `${BUILDER_HOME}/.npm`,
    COREPACK_HOME: `${BUILDER_HOME}/.cache/node/corepack`,
    YARN_CACHE_FOLDER: `${BUILDER_HOME}/.cache/yarn`,
    BUN_INSTALL: `${BUILDER_HOME}/.bun`,
  };
}

/**
 * spawn() options for an untrusted build child: run in WORK_DIR, pipe stdio, and
 * drop to the non-root BUILDER_UID/GID. Pure + exported so the uid drop is
 * unit-testable without spawning (the real setuid only works as root, in the
 * container). spawn() throws EPERM if a non-root process passes `uid`, which is
 * the intended fail-closed posture: untrusted code must not run as the agent's
 * uid, so a misconfigured non-root agent fails rather than silently co-locating.
 * @returns {{ cwd: string, stdio: Array<'ignore' | 'pipe' | 'inherit'>, uid: number, gid: number }}
 */
export function childSpawnOptions() {
  return {
    cwd: WORK_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    uid: BUILDER_UID,
    gid: BUILDER_GID,
  };
}

/**
 * Pinned fallback version used when the repo has no local `void` to run via npx.
 * Reads VOID_CLI_VERSION (injected by BuildManager) at call time, falling back
 * to the baked-in default. Never `latest` — a moving dist-tag must not change
 * deploy behavior with no repo diff.
 * @returns {string}
 */
function voidFallbackVersion() {
  return process.env.VOID_CLI_VERSION || DEFAULT_VOID_CLI_VERSION;
}

// --- mutable build state -----------------------------------------------------

/**
 * The currently-running untrusted build child (dependency install OR `void
 * deploy`). At most one runs at a time — install is awaited and the BUILDER_UID
 * sweep runs before the deploy child spawns — so a single slot is unambiguous.
 * Held so a cancel (POST /cancel or a PID-1 SIGTERM) interrupts whichever phase
 * is in flight, the install INCLUDED: a cancel during install must not let it
 * run to completion and burn the container slot.
 * @type {import('node:child_process').ChildProcess | null}
 */
let activeChild = null;
let cancelled = false;

/**
 * Monotonic, in-memory ring of recent log lines. `seq` is the 1-based index of
 * the line; `GET /logs?since=N` returns lines with seq > N. Kept so a PULL-mode
 * DO can drain logs even if push (POST to DO_LOG_URL) is unavailable. BOUNDED by
 * MAX_BUFFERED_LOG_LINES (see below).
 * @type {Array<{ seq: number, line: string, stream: 'stdout' | 'stderr', ts: number }>}
 */
const logBuffer = [];
let logSeq = 0;

/**
 * Hard cap on the retained PULL history. A pathologically verbose build (huge
 * package-manager / compiler output) would otherwise grow `logBuffer` without
 * bound and OOM the agent on the memory-constrained standard-1 container, failing
 * an otherwise-valid build purely because it logged too much. `record()` evicts
 * the oldest lines in a chunk once over this cap. The /logs pull is a best-effort
 * tail, so a far-behind puller simply misses the very start; `seq` stays
 * monotonic, so `since` queries over RETAINED lines are still exact.
 */
export const MAX_BUFFERED_LOG_LINES = 10000;

/**
 * Hard cap on the unflushed PUSH batch. `pendingLines` is drained every
 * LOG_FLUSH_MS, but a flood can outrun the flush WITHIN a single synchronous
 * `data` handler: `pipeStream` scans an entire chunk in one turn, so a chunk
 * carrying millions of delimiters (a bare-`\r` progress flood, or a `\n`-only
 * blast) makes millions of `record()` calls — and the flush timer can't fire
 * until that turn yields — ballooning the batch and OOMing the standard-1
 * container. The per-line byte cap (MAX_PARTIAL_LINE_CHARS) bounds one line's
 * SIZE but not the COUNT of short delimiter-emitted lines, so this bounds the
 * count too. `record()` evicts the oldest entries once over the cap (mirroring
 * the `logBuffer` ring); the most-recent output — what a live tail cares about —
 * is preserved, and the retained PULL history (`logBuffer`) is independently
 * bounded, so a far-behind reader simply misses the flood's start.
 */
export const MAX_PENDING_LOG_LINES = 10000;

/**
 * Pending lines not yet flushed to the DO. Drained every LOG_FLUSH_MS. Bounded
 * by MAX_PENDING_LOG_LINES (see above) so a log flood can't OOM the agent.
 * @type {Array<{ line: string, stream: 'stdout' | 'stderr', ts: number }>}
 */
let pendingLines = [];

/**
 * Backpressure latch for the stderr mirror in `record()`. The in-memory buffers
 * are capped, but `process.stderr.write` ALSO queues in Node's Writable buffer
 * when the sink can't keep up — a flood whose log consumer drains slowly (or not
 * at all) would grow that buffer without bound, moving the same OOM into the
 * stream layer. Set when `write()` signals saturation (returns false), cleared on
 * the next 'drain'; while set, the mirror is skipped. The mirror is best-effort
 * and dropped lines remain in logBuffer (PULL) + pendingLines (PUSH), so skipping
 * it under saturation loses nothing primary.
 */
let stderrSaturated = false;

// --- DO endpoints (best-effort push) ----------------------------------------

const DO_LOG_URL = process.env.DO_LOG_URL ?? '';
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? '';

// Drop these control-plane secrets from the PARENT process's heap env once
// captured into the module-level consts above. `postToDo` reads the consts (and
// DO_STATUS_URL, derived from the DO_LOG_URL const below) — NOT process.env — so
// this is functionally inert for the build. It is defense-in-depth ONLY for the
// spawn-inheritance path (a child spawned with the parent's `process.env` would
// otherwise inherit these); `sanitizeChildEnv` is the real control there, since
// every untrusted child is given a scrubbed COPY anyway.
//
// NOTE: `delete process.env.X` calls `unsetenv()`, which mutates only the in-heap
// `environ` array; `/proc/<pid>/environ` reflects the initial-stack env block set
// at `execve` and still returns the original secret. The agent runs as root with
// no PID isolation, so on its own this delete would NOT stop a child from reading
// the parent's `/proc/<ppid>/environ`. That vector is closed at the uid boundary
// Untrusted children run as the non-root BUILDER_UID (childSpawnOptions), so
// their cross-uid read of the root agent's /proc is denied by the kernel. This
// delete remains as defense-in-depth for the spawn-inheritance path.
delete process.env.AGENT_TOKEN;
delete process.env.DO_LOG_URL;

/** Derive a sibling DO endpoint (e.g. /status) from DO_LOG_URL's origin. */
function doEndpoint(pathname) {
  if (!DO_LOG_URL) {
    return '';
  }
  try {
    const u = new URL(DO_LOG_URL);
    u.pathname = pathname;
    u.search = '';
    return u.toString();
  } catch {
    return '';
  }
}

const DO_STATUS_URL = doEndpoint('/status');

/**
 * POST JSON to a DO endpoint. Best-effort: any failure (transport, non-2xx,
 * missing URL) is swallowed so a log/status hiccup never aborts the build.
 * @param {string} url
 * @param {unknown} body
 */
async function postToDo(url, body) {
  if (!url) {
    return;
  }
  try {
    /** @type {Record<string, string>} */
    const headers = { 'content-type': 'application/json' };
    // The DO authenticates control POSTs with the per-build secret. The agent
    // (parent process) holds AGENT_TOKEN; untrusted repo child processes never
    // see it (scrubbed by `sanitizeChildEnv`), so they can't authenticate.
    if (AGENT_TOKEN) {
      headers.authorization = `Bearer ${AGENT_TOKEN}`;
    }
    await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      // Bound a slow/hung DO so the caller (the single-flight log flush) can't
      // stall indefinitely — see DO_POST_TIMEOUT_MS. AbortError lands in catch.
      signal: AbortSignal.timeout(DO_POST_TIMEOUT_MS),
    });
  } catch {
    // Best-effort — never throw into the build path.
  }
}

/** Report a build status to the DO (best-effort). */
async function reportStatus(status) {
  await postToDo(DO_STATUS_URL, { status });
}

// --- log capture + batched flush ---------------------------------------------

/**
 * Record a line: append to the in-memory ring (for PULL) and the pending batch
 * (for PUSH).
 * @param {string} line
 * @param {'stdout' | 'stderr'} stream
 */
export function record(line, stream) {
  const ts = Date.now();
  logSeq += 1;
  logBuffer.push({ seq: logSeq, line, stream, ts });
  // Bound the retained history (see MAX_BUFFERED_LOG_LINES): once over the cap,
  // drop the oldest fifth in one splice so eviction is amortized O(1) per line —
  // a per-line front-shift would be O(n^2) over a long, verbose build.
  if (logBuffer.length > MAX_BUFFERED_LOG_LINES) {
    logBuffer.splice(0, Math.ceil(MAX_BUFFERED_LOG_LINES / 5));
  }
  pendingLines.push({ line, stream, ts });
  // Bound the unflushed PUSH batch the same way as logBuffer (see
  // MAX_PENDING_LOG_LINES): a flood can fill it faster than LOG_FLUSH_MS drains,
  // so evict the oldest fifth in one splice once over the cap — amortized O(1)
  // per line, keeping the most-recent output.
  if (pendingLines.length > MAX_PENDING_LOG_LINES) {
    pendingLines.splice(0, Math.ceil(MAX_PENDING_LOG_LINES / 5));
  }
  // Also mirror to the container's own stderr. This is the last-resort log
  // path: if DO push transport is unavailable and the DO never PULLs, the
  // build output is still visible in the container's runtime logs. Respect
  // backpressure (see stderrSaturated): once write() reports the sink is full,
  // skip mirroring until 'drain' so a flood with a slow consumer can't grow the
  // Writable's internal buffer without bound.
  if (!stderrSaturated && !process.stderr.write(`${line}\n`)) {
    stderrSaturated = true;
    process.stderr.once('drain', () => {
      stderrSaturated = false;
    });
  }
}

/** Agent-originated line (not from the child) — surfaced on both streams' UI. */
function agentLog(line) {
  record(`[build-agent] ${line}`, 'stdout');
}

/** Test-only: snapshot of the retained PULL buffer (bounded by MAX_BUFFERED_LOG_LINES). */
export function getBufferedLogLines() {
  return logBuffer.slice();
}

/** Test-only: current length of the unflushed PUSH batch (bounded by MAX_PENDING_LOG_LINES). */
export function getPendingLogLineCount() {
  return pendingLines.length;
}

/** In-flight flush promise, or null when idle. See flushLogs. */
let flushInFlight = null;

/**
 * Flush pending lines to the DO. Best-effort and SINGLE-FLIGHT: the flush runs on
 * a fire-and-forget interval, so a fire-and-forget `await postToDo()` against a
 * slow/hung DO would let every 500ms tick start ANOTHER POST, each retaining its
 * (bounded) batch + JSON body in an unresolved promise — accumulating those bodies
 * without bound and moving the OOM into the network layer. Instead, concurrent
 * callers (the interval and the final drain at exit) JOIN the in-flight promise
 * rather than starting a parallel POST, and the loop drains every line that
 * arrived during each await before resolving. So at most ONE POST is ever in
 * flight, and `await flushLogs()` at exit waits for a complete drain.
 * @returns {Promise<void>}
 */
export function flushLogs() {
  if (flushInFlight) {
    return flushInFlight;
  }
  flushInFlight = (async () => {
    try {
      while (pendingLines.length > 0) {
        const batch = pendingLines;
        pendingLines = [];
        await postToDo(DO_LOG_URL, batch);
      }
    } finally {
      flushInFlight = null;
    }
  })();
  return flushInFlight;
}

/**
 * Per-line character cap for `pipeStream`. A producer that writes a very long
 * run with no line terminator (a `\n`-free blob, or a pure-`\r` progress stream)
 * would otherwise grow the partial-line buffer until it OOMs the standard-1
 * container on an otherwise-valid build. A line over this length is recorded
 * truncated (and the rest of that one line is dropped until its terminator), so
 * a single terminator-free run yields ONE bounded record — not the whole run.
 */
export const MAX_PARTIAL_LINE_CHARS = 128 * 1024;

/** Appended to a line that exceeded MAX_PARTIAL_LINE_CHARS and was cut short. */
const LINE_TRUNCATION_MARKER = ' …[line truncated]';

/**
 * Turn a readable stream of bytes into line-delimited `record()` calls. Splits
 * on CR, LF, or CRLF so carriage-return progress frames (install/build spinners
 * that rewrite a line with bare `\r` and no `\n`) flush as lines live, instead
 * of being held until the process exits.
 *
 * Two cross-chunk concerns drive the hand-rolled scan rather than a `split()`:
 *   - Torn CRLF: a CR may be the last byte of one chunk and the LF the first of
 *     the next. A bare CR is treated as a line delimiter immediately; `pendingLf`
 *     then swallows a single leading LF on the next chunk so a CRLF collapses to
 *     one break instead of opening an empty line. The CR is NEVER buffered as
 *     data, so it can't later be flushed mid-line or at EOF.
 *   - Unbounded line: a line over MAX_PARTIAL_LINE_CHARS is recorded truncated
 *     and `dropping` discards the remainder until the next delimiter, so a
 *     terminator-free flood is bounded to a single record instead of being
 *     retained in full (the MAX_BUFFERED_LOG_LINES ring caps line COUNT, not
 *     bytes, so a full over-cap line would still let the buffer balloon).
 * @param {NodeJS.ReadableStream} source
 * @param {'stdout' | 'stderr'} stream
 */
export function pipeStream(source, stream) {
  let tail = ''; // current unterminated line; never holds a trailing CR
  let pendingLf = false; // prior delimiter was a CR — swallow one leading LF (CRLF)
  let dropping = false; // truncated an over-cap line — drop bytes until its terminator

  /** Record `line`, truncated if it exceeds the per-line cap. */
  const recordLine = (line) => {
    record(
      line.length > MAX_PARTIAL_LINE_CHARS
        ? line.slice(0, MAX_PARTIAL_LINE_CHARS) + LINE_TRUNCATION_MARKER
        : line,
      stream,
    );
  };

  source.setEncoding('utf8');
  source.on('data', (chunk) => {
    const n = chunk.length;
    let i = 0;
    while (i < n) {
      // Swallow the LF half of a CRLF that was torn across the chunk boundary.
      if (pendingLf) {
        pendingLf = false;
        if (chunk[i] === '\n') {
          i += 1;
          continue;
        }
      }
      // Scan to the next CR or LF delimiter.
      let j = i;
      while (j < n && chunk[j] !== '\n' && chunk[j] !== '\r') {
        j += 1;
      }
      if (j < n) {
        // Delimiter at j terminates the current line.
        if (dropping) {
          dropping = false; // the over-cap line ended; resume normal recording
        } else {
          recordLine(tail + chunk.slice(i, j));
          tail = '';
        }
        if (chunk[j] === '\r') {
          pendingLf = true; // a following LF (this/next chunk) is the CRLF's other half
        }
        i = j + 1;
      } else {
        // No delimiter to end of chunk — extend the partial line.
        if (!dropping) {
          tail += chunk.slice(i, n);
          if (tail.length > MAX_PARTIAL_LINE_CHARS) {
            record(tail.slice(0, MAX_PARTIAL_LINE_CHARS) + LINE_TRUNCATION_MARKER, stream);
            tail = '';
            dropping = true; // drop the rest of this line until its terminator
          }
        }
        i = n;
      }
    }
  });
  source.on('end', () => {
    // A dangling CR (pendingLf) already acted as a delimiter, so nothing trails
    // it; only a genuine unterminated partial line remains in `tail`.
    if (!dropping && tail.length > 0) {
      recordLine(tail);
    }
    tail = '';
  });
}

// --- HTTP control server -----------------------------------------------------
// GET /            -> 200 health (DO readiness probe)
// GET /logs?since= -> buffered lines with seq > since (PULL fallback)
// POST /cancel     -> set cancel flag + SIGTERM the active build child

function startControlServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/logs') {
      const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10) || 0;
      const lines = logBuffer.filter((entry) => entry.seq > since);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ lines, lastSeq: logSeq }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/cancel') {
      cancelled = true;
      agentLog('cancel requested');
      if (activeChild && activeChild.exitCode === null) {
        try {
          activeChild.kill('SIGTERM');
        } catch {
          // already gone
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(PORT, () => resolve(server));
  });
}

/**
 * Close the HTTP control server so its open listening socket can't keep the
 * Node event loop alive after the build resolves. Best-effort + idempotent: a
 * null server or an already-closed server resolves without throwing. Exported
 * so the lifecycle invariant (server closed on every exit path) is unit-testable.
 * @param {import('node:http').Server | null | undefined} server
 * @returns {Promise<void>}
 */
export function closeControlServer(server) {
  if (!server) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

// --- source download ---------------------------------------------------------

/**
 * Download the GitHub source tarball (authenticated) and extract it into
 * WORK_DIR, stripping the top-level `<repo>-<sha>/` directory. Streams bytes
 * straight into `tar` to avoid buffering the whole archive in memory.
 *
 * Uses Node's built-in fetch (so the SOURCE_TOKEN is never placed on a shell
 * command line). Equivalent curl form, documented as a fallback:
 *   curl -fsSL -H "Authorization: Bearer $SOURCE_TOKEN" "$SOURCE_TARBALL_URL" \
 *     | tar xz --strip-components=1 -C "$WORK_DIR"
 */
async function downloadSource() {
  const tarballUrl = requireEnv('SOURCE_TARBALL_URL');
  const sourceToken = requireEnv('SOURCE_TOKEN');

  mkdirSync(WORK_DIR, { recursive: true });
  agentLog(`downloading source from ${redactUrl(tarballUrl)}`);

  const res = await fetch(tarballUrl, {
    headers: {
      authorization: `Bearer ${sourceToken}`,
      // GitHub codeload follows a redirect from api.github.com; UA keeps it happy.
      'user-agent': 'void-build-agent',
      accept: 'application/vnd.github+json',
    },
    redirect: 'follow',
  });
  if (!res.ok || !res.body) {
    throw new Error(`source download failed: HTTP ${res.status}`);
  }
  if (cancelled) {
    // Cancel landed during the fetch await — don't start extraction at all.
    throw new Error('build cancelled');
  }

  await new Promise((resolve, reject) => {
    const tar = spawn('tar', ['xz', '--strip-components=1', '-C', WORK_DIR], {
      stdio: ['pipe', 'inherit', 'pipe'],
    });
    // Track the extraction child as the cancel target, mirroring runChild. A
    // /cancel (or PID-1 SIGTERM) now SIGTERMs tar promptly instead of being a
    // no-op for the whole download: killing tar closes its stdin, so the
    // `pipeline` below rejects and destroys the source web stream — which also
    // aborts the in-flight fetch body pull. Previously the tar child was never
    // registered, so a cancel during a large download kept pulling + extracting
    // the full archive before the post-download gate (runBuild) finally bailed.
    activeChild = tar;
    if (cancelled) {
      // Cancel raced the spawn — terminate immediately.
      try {
        tar.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    pipeStream(/** @type {NodeJS.ReadableStream} */ (tar.stderr), 'stderr');
    tar.on('error', reject);
    tar.on('close', (code) => {
      activeChild = null;
      if (code === 0) {
        resolve(undefined);
      } else {
        reject(new Error(`tar exited with code ${code}`));
      }
    });
    // Use `pipeline` (not a bare `.pipe()`): the source web stream can abort
    // mid-download, and a bare pipe would emit 'error' on the Readable with no
    // listener → an uncaughtException that crashes the process WITHOUT the
    // structured fatal log / final flushLogs. `pipeline` routes a source error
    // to `reject`, so it surfaces through runBuild's try/catch as a clean exit 1.
    pipeline(Readable.fromWeb(/** @type {any} */ (res.body)), tar.stdin).catch(reject);
  });

  agentLog('source extracted');
}

// --- dependency install ------------------------------------------------------

/**
 * Read the repo's `package.json#packageManager` pin (e.g. "pnpm@9.1.0"). Returns
 * the raw string, or '' if the file is missing/unreadable/has no pin. Wrapped in
 * try/catch so a malformed package.json can't crash install resolution.
 * @returns {string}
 */
function readPackageManagerPin() {
  try {
    const pkg = JSON.parse(readFileSync(`${WORK_DIR}/package.json`, 'utf8'));
    return typeof pkg.packageManager === 'string' ? pkg.packageManager : '';
  } catch {
    return '';
  }
}

/**
 * Sniffs `WORK_DIR/yarn.lock` to tell Yarn Classic (v1) from Berry (v2+) when no
 * `packageManager` pin disambiguates. Yarn 1 locks carry a `# yarn lockfile v1`
 * header; Berry locks carry a `__metadata:` block. Returns 'classic' | 'berry' |
 * 'unknown' (missing/unreadable/empty). Wrapped in try/catch like
 * readPackageManagerPin so a read error can't crash install resolution.
 * @returns {'classic' | 'berry' | 'unknown'}
 */
function readYarnLockKind() {
  try {
    const head = readFileSync(`${WORK_DIR}/yarn.lock`, 'utf8').slice(0, 200);
    if (head.includes('# yarn lockfile v1')) {
      return 'classic';
    }
    if (head.includes('__metadata:')) {
      return 'berry';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Detect a Berry `yarnPath` in `WORK_DIR/.yarnrc.yml`. When present, the
 * corepack-default Yarn Classic (1.22) re-execs that bundled Berry release (the
 * `yarnPath` re-exec is honored by Yarn 1.x), so a Berry repo builds correctly
 * even with no `packageManager` pin. Substring sniff (like readYarnLockKind),
 * try/catch so a missing/unreadable file can't crash install resolution.
 * @returns {boolean}
 */
function hasYarnrcYarnPath() {
  try {
    return /^\s*yarnPath\s*:/m.test(readFileSync(`${WORK_DIR}/.yarnrc.yml`, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Detect the package manager from the lockfile present in WORK_DIR and return
 * the install command + argv. corepack runs pnpm/yarn so the repo's
 * `packageManager` pin is honored; bun and npm run directly.
 */
function resolveInstall() {
  if (existsSync(`${WORK_DIR}/pnpm-lock.yaml`)) {
    return { manager: 'pnpm', cmd: 'corepack', args: ['pnpm', 'install', '--frozen-lockfile'] };
  }
  if (existsSync(`${WORK_DIR}/bun.lock`) || existsSync(`${WORK_DIR}/bun.lockb`)) {
    return { manager: 'bun', cmd: 'bun', args: ['install', '--frozen-lockfile'] };
  }
  if (existsSync(`${WORK_DIR}/yarn.lock`)) {
    // Yarn Classic (1.x) does NOT recognize Berry's `--immutable` and would
    // SILENTLY run a MUTABLE install, losing the frozen-lockfile guarantee.
    // Choose the flag by the Yarn version that will ACTUALLY run:
    //   - pin `yarn@1.x`              → `--frozen-lockfile` (Classic)
    //   - pin `yarn@2+`               → `--immutable` (Berry)
    //   - no pin, `.yarnrc.yml` yarnPath present → Yarn 1.22 re-execs the bundled
    //     Berry release → `--immutable` (Berry), regardless of lock header.
    //   - no pin, no yarnPath, Berry `__metadata` lock → corepack's default Yarn
    //     1.22 (Classic) would run, but it ignores `--immutable` AND cannot parse
    //     a Berry lock. There is no resolvable Yarn version, so FAIL FAST with
    //     actionable guidance instead of a confusing mid-install error.
    //   - no pin otherwise (Classic `# yarn lockfile v1` header / unknown lock)
    //     → Classic's `--frozen-lockfile`.
    const pin = readPackageManagerPin();
    let flag;
    if (/^yarn@1\./.test(pin)) {
      flag = '--frozen-lockfile';
    } else if (/^yarn@/.test(pin)) {
      flag = '--immutable';
    } else if (hasYarnrcYarnPath()) {
      flag = '--immutable';
    } else if (readYarnLockKind() === 'berry') {
      throw new Error(
        'Yarn Berry (v2+) lockfile detected but no Yarn version is resolvable. Add a ' +
          '"packageManager" field (e.g. "yarn@4.x") to package.json, or commit a .yarnrc.yml ' +
          'with a yarnPath, so the build runs the correct Yarn.',
      );
    } else {
      flag = '--frozen-lockfile';
    }
    return { manager: 'yarn', cmd: 'corepack', args: ['yarn', 'install', flag] };
  }
  // npm: prefer `ci` when a lockfile exists, else plain `install`.
  if (existsSync(`${WORK_DIR}/package-lock.json`)) {
    return { manager: 'npm', cmd: 'npm', args: ['ci'] };
  }
  // No lockfile. Before defaulting to `npm install` (which would break a pnpm
  // `workspace:*` repo / install a different graph), honor a `packageManager`
  // pin if present. No lockfile means no frozen flag.
  const pin = readPackageManagerPin();
  if (pin.startsWith('pnpm@')) {
    return { manager: 'pnpm', cmd: 'corepack', args: ['pnpm', 'install'] };
  }
  if (pin.startsWith('yarn@')) {
    return { manager: 'yarn', cmd: 'corepack', args: ['yarn', 'install'] };
  }
  if (pin.startsWith('bun@')) {
    return { manager: 'bun', cmd: 'bun', args: ['install'] };
  }
  return { manager: 'npm', cmd: 'npm', args: ['install'] };
}

// --- child process runner -----------------------------------------------------

/**
 * Spawn a child in WORK_DIR, stream its stdout/stderr into the log pipeline,
 * and resolve with its exit code. Honors the cancel flag (SIGTERM).
 *
 * `opts.env` MUST be supplied for any step that runs untrusted repo code (the
 * package-manager install and `void deploy`, whose lifecycle scripts the repo
 * controls). Use `sanitizeChildEnv(...)` to strip the control-plane + credential
 * secrets (DO_LOG_URL, SOURCE_TOKEN, AGENT_TOKEN, VOID_TOKEN) so a malicious
 * postinstall can't reach/authenticate to the DO endpoints or steal the deploy
 * token. The deploy step re-injects VOID_TOKEN via the `extra` overrides.
 * @param {string} cmd
 * @param {Array<string>} args
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<number>}
 */
function runChild(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    agentLog(`$ ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, {
      ...childSpawnOptions(),
      env: opts.env ?? process.env,
    });
    // Track every child as the active cancel target. Only one untrusted child
    // runs at a time (install is awaited before the deploy child spawns), so a
    // cancel that arrives mid-install now interrupts the install instead of
    // being a no-op — previously only the deploy child was tracked, so a cancel
    // during install let it run to completion and burn the container slot.
    activeChild = child;
    if (cancelled) {
      // Cancel raced the spawn — terminate immediately.
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    pipeStream(/** @type {NodeJS.ReadableStream} */ (child.stdout), 'stdout');
    pipeStream(/** @type {NodeJS.ReadableStream} */ (child.stderr), 'stderr');
    child.on('error', reject);
    child.on('close', (code, signal) => {
      activeChild = null;
      // Signal-terminated (e.g. cancel) reports as non-zero so the DO fails it.
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

/**
 * Hand the just-extracted source tree to the non-root builder uid. `tar` runs as
 * the root agent, so WORK_DIR's contents are root-owned, but the install/deploy
 * children run as BUILDER_UID (childSpawnOptions) and must write node_modules /
 * build output into it. Only root can chown to another uid, so this is a no-op
 * when the agent is NOT root — i.e. off-container unit tests, where the real
 * install/deploy is injected away anyway.
 * @returns {Promise<void>}
 */
function chownWorkDirToBuilder() {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const child = spawn('chown', ['-R', `${BUILDER_UID}:${BUILDER_GID}`, WORK_DIR], {
      stdio: ['ignore', 'inherit', 'pipe'],
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(undefined);
      } else {
        reject(new Error(`chown exited with code ${code}`));
      }
    });
  });
}

/**
 * Parse the real uid out of a `/proc/<pid>/status` blob (the first field of the
 * `Uid:\t<real>\t<effective>\t<saved>\t<fs>` line). Returns null when the line
 * is absent (kernel-thread races, truncated read). Exported so the parse is
 * unit-testable without a real `/proc`.
 * @param {string} statusText
 * @returns {number | null}
 */
export function parseProcStatusUid(statusText) {
  const match = /^Uid:\s+(\d+)/m.exec(statusText);
  return match ? Number(match[1]) : null;
}

/**
 * SIGKILL every process owned by BUILDER_UID. Run AFTER the install child has
 * closed and BEFORE the deploy child spawns: a dependency lifecycle script
 * (postinstall etc.) that daemonizes during install survives the install child's
 * close by reparenting to the pid-1 agent, and runs as the SAME BUILDER_UID as
 * the upcoming deploy child. Same-uid `/proc/<pid>/environ` reads are permitted
 * by the kernel, so such a leftover could read the deploy child's environ — which
 * carries the re-injected `VOID_TOKEN` and the staging CF Access pair. The
 * existing root-vs-builder uid boundary only denies a child reading the ROOT
 * agent's `/proc`; it does NOT cover this sibling-to-sibling vector.
 *
 * This is best-effort defense-in-depth, NOT a complete close. It is a single
 * `/proc` sweep: it SIGKILLs processes alive at the instant of the scan, so it
 * reaps the straightforward "daemonize during install" case. It does NOT seal the
 * vector — a process that double-forks a new child after this scan's `readdir`
 * (its pid never enumerated), or re-spawns faster than one sweep, survives into
 * the deploy window. The kernel-enforced complete fix is per-phase UID separation
 * (a distinct uid for the deploy child), deferred because deploy and install
 * share one `node_modules`/work-tree. Crucially the residual is bounded by — and
 * dominated by — the already-accepted trust-split limitation: `void deploy` runs
 * the project's own (untrusted) build in-process, so that code holds VOID_TOKEN
 * directly regardless of this sweep. The reap narrows the surface; it does not,
 * and cannot here, eliminate it.
 *
 * Root-gated like {@link chownWorkDirToBuilder} (only root can signal another
 * uid's processes; off-container unit tests aren't root and inject the real
 * install/deploy away anyway). The slim node base image ships no `pkill`/procps,
 * so this scans `/proc` directly. Killing all BUILDER_UID processes is safe at
 * this point: the install child is already awaited closed and the deploy child is
 * not yet spawned, so nothing legitimate runs as BUILDER_UID.
 * @returns {Promise<void>}
 */
function killBuilderProcesses() {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    return Promise.resolve();
  }
  let entries;
  try {
    entries = readdirSync('/proc');
  } catch {
    return Promise.resolve();
  }
  let killed = 0;
  for (const entry of entries) {
    const pid = Number(entry);
    // Skip non-pid entries and pid 1 (the root agent — never our target, and
    // killing it would tear down the build itself).
    if (!Number.isInteger(pid) || pid <= 1) {
      continue;
    }
    let uid;
    try {
      uid = parseProcStatusUid(readFileSync(`/proc/${pid}/status`, 'utf8'));
    } catch {
      // Process exited between readdir and read — nothing to kill.
      continue;
    }
    if (uid !== BUILDER_UID) {
      continue;
    }
    try {
      process.kill(pid, 'SIGKILL');
      killed++;
    } catch {
      // Already gone / unsignalable — best effort.
    }
  }
  if (killed > 0) {
    agentLog(`reaped ${killed} leftover builder process(es) before deploy`);
  }
  return Promise.resolve();
}

// --- env helpers --------------------------------------------------------------

/**
 * Control-plane + credential env vars that must NEVER reach untrusted repo
 * child processes by default. `DO_LOG_URL` is the DO endpoint origin;
 * `SOURCE_TOKEN` is the GitHub installation token; `AGENT_TOKEN` authenticates
 * control POSTs; `VOID_TOKEN` is the live project-scoped deploy JWT. A repo's
 * lifecycle scripts (postinstall etc.) running with these in `process.env`
 * could forge build status, scrape the source token, hit the DO directly, or
 * exfiltrate the deploy token / publish artifacts to the scoped project within
 * the token TTL. `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` are the shared
 * staging CF Access service token (present only on staging builds) — a leaked
 * pair would let untrusted code reach every Access-gated staging host, so they
 * are scrubbed too. `VOID_TOKEN` and the CF Access pair are the secrets the
 * trusted `void deploy` invocation legitimately needs, so the deploy spawn
 * re-injects them via the `extra` overrides — the install (and every other
 * untrusted) child never sees them.
 * @type {ReadonlyArray<string>}
 */
export const SCRUBBED_ENV_VARS = [
  'DO_LOG_URL',
  'SOURCE_TOKEN',
  'AGENT_TOKEN',
  'VOID_TOKEN',
  'CF_ACCESS_CLIENT_ID',
  'CF_ACCESS_CLIENT_SECRET',
];

/**
 * Build the env for a child process that runs untrusted repo code. Starts from
 * the current `process.env`, drops every control-plane secret in
 * `SCRUBBED_ENV_VARS`, and applies any `extra` overrides. Pure + exported so it
 * can be unit-tested without spawning anything.
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {Record<string, string | undefined>} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
export function sanitizeChildEnv(baseEnv, extra = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...baseEnv };
  for (const key of SCRUBBED_ENV_VARS) {
    delete env[key];
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var ${name}`);
  }
  return value;
}

/** Strip query/userinfo from a URL for logging (codeload URLs are tokenless,
 *  but be defensive about anything sensitive in the query string). */
function redactUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '<source tarball>';
  }
}

// --- main ---------------------------------------------------------------------

/**
 * Run the build pipeline and resolve to the process exit code (0 = success,
 * non-zero = failure). This function NEVER calls `process.exit` and NEVER
 * leaves via an early `return` that bypasses an exit decision: every phase
 * resolves to a code that the single top-level driver (`main`) hands to
 * `process.exit`. The container must always terminate, so a failed install /
 * download / deploy returns a non-zero code rather than dropping out of the
 * driver and letting the still-open control server keep the process alive.
 *
 * Step functions are injectable so the lifecycle invariant (install failure ->
 * non-zero exit code, no hang) is unit-testable without spawning anything.
 * @param {{
 *   downloadSource?: () => Promise<void>,
 *   resolveInstall?: () => { manager: string, cmd: string, args: Array<string> },
 *   runChild?: (cmd: string, args: Array<string>, opts?: { env?: NodeJS.ProcessEnv }) => Promise<number>,
 *   reportStatus?: (status: string) => Promise<void>,
 *   hasLocalVoid?: () => boolean,
 *   chownWorkDir?: () => Promise<void>,
 * }} [deps]
 * @returns {Promise<number>}
 */
export async function runBuild(deps = {}) {
  const download = deps.downloadSource ?? downloadSource;
  const install = deps.resolveInstall ?? resolveInstall;
  const run = deps.runChild ?? runChild;
  const chownWorkDir = deps.chownWorkDir ?? chownWorkDirToBuilder;
  const killBuilders = deps.killBuilderProcesses ?? killBuilderProcesses;
  const status = deps.reportStatus ?? reportStatus;
  // A present `.pnp.cjs` means the repo uses Yarn Berry Plug'n'Play: there is no
  // `node_modules` tree, so the deploy must run THROUGH the package manager
  // (`corepack yarn ...`) to activate the PnP runtime rather than bare npx.
  // `pnpPresent` only selects the RUNNER below — it must NOT be conflated with
  // "void is locally resolvable": a PnP repo that does not declare `void` still
  // needs the `yarn dlx void@<ver>` fetch fallback, so the local-void signal is
  // an actual dependency check, not the mere presence of `.pnp.cjs`.
  //
  // Assigned AFTER the install step (below): a Yarn Berry PnP repo may not commit
  // `.pnp.cjs` and instead GENERATE it during `yarn install`, so a pre-install (or
  // pre-download) check would read `false` and silently route it down the bare-
  // `npx` path (which can't resolve PnP-managed deps during `void deploy`).
  // `hasLocalVoid` and the runner selection both read it lazily (after install),
  // so a reassignable `let` is correct.
  let pnpPresent = false;
  // Whether the repo DECLARES `void` as a dependency — the accurate "is void
  // locally resolvable" signal under PnP, where `node_modules/.bin/void` never
  // exists. Falls back to `false` on any read/parse error (→ fetch the CLI).
  const repoDeclaresVoid = () => {
    try {
      const pkg = JSON.parse(readFileSync(`${WORK_DIR}/package.json`, 'utf8'));
      return Boolean(pkg.dependencies?.void || pkg.devDependencies?.void);
    } catch {
      return false;
    }
  };
  const hasLocalVoid =
    deps.hasLocalVoid ??
    (() => existsSync(`${WORK_DIR}/node_modules/.bin/void`) || (pnpPresent && repoDeclaresVoid()));

  try {
    // Capture the deploy token into a local, then drop it from the parent's heap
    // env. Only the trusted `void deploy` child legitimately needs it, and it is
    // re-injected there via the `extra` overrides below. Deleting it from
    // `process.env` is defense-in-depth for the spawn-inheritance path only:
    // `sanitizeChildEnv` already strips it from every untrusted child's COPY, so
    // the install child never sees it.
    //
    // This delete does NOT scrub `/proc/self/environ` (`unsetenv()` mutates only
    // the heap `environ`), but the install child runs as the non-root BUILDER_UID,
    // so its cross-uid read of the root agent's `/proc/<ppid>/environ` is
    // denied. NOTE: VOID_TOKEN is RE-INJECTED into the deploy child's OWN env
    // below, so the untrusted `vite build` run inside `void deploy` can still read
    // it from its own `/proc/self/environ` — that is the separate CLI
    // trust-split escalation, not addressed by the uid boundary.
    const voidToken = requireEnv('VOID_TOKEN');
    delete process.env.VOID_TOKEN;
    // Staging CF Access service token (set only on staging builds). Capture +
    // drop from the parent heap exactly like VOID_TOKEN; re-injected only into
    // the trusted deploy child below so `void deploy` can authenticate past CF
    // Access on `api.staging.void.cloud`. Absent on production/dev builds.
    const cfAccessClientId = process.env.CF_ACCESS_CLIENT_ID;
    const cfAccessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
    delete process.env.CF_ACCESS_CLIENT_ID;
    delete process.env.CF_ACCESS_CLIENT_SECRET;
    requireEnv('VOID_API_URL');
    const project = requireEnv('VOID_PROJECT');

    if (cancelled) {
      throw new Error('build cancelled before start');
    }

    // 1. Download + extract source. The source token is last needed for the
    //    authenticated tarball fetch inside `download()`; drop it from the
    //    parent's heap env the moment the download completes, BEFORE the
    //    untrusted install/build children spawn. This is defense-in-depth for the
    //    spawn-inheritance path only — `sanitizeChildEnv` already strips it from
    //    every untrusted child's COPY. The heap delete does NOT scrub
    //    `/proc/self/environ` (`unsetenv()` only touches the heap `environ`), but
    //    the install/deploy children run as the non-root BUILDER_UID, so
    //    their cross-uid read of the root agent's `/proc/<ppid>/environ` is denied
    //    by the kernel. The token is also repo-scoped + read-only (BuildManager
    //    mints it with `{ contents: 'read' }` for this one repo).
    await download();
    delete process.env.SOURCE_TOKEN;
    // Hand the root-extracted tree to the non-root builder so the install/deploy
    // children (spawned as BUILDER_UID) can write into it. No-op off-container.
    await chownWorkDir();
    if (cancelled) {
      throw new Error('build cancelled');
    }

    // 2. Install dependencies. Repo lifecycle scripts (postinstall etc.) run
    //    here with a scrubbed env — no DO_LOG_URL/SOURCE_TOKEN/AGENT_TOKEN and
    //    no VOID_TOKEN — so they can't forge build status, exfiltrate the source
    //    token, or steal the deploy token.
    const installPlan = install();
    agentLog(`detected package manager: ${installPlan.manager}`);
    const installCode = await run(installPlan.cmd, installPlan.args, {
      env: sanitizeChildEnv(process.env, builderCacheEnv()),
    });
    if (installCode !== 0) {
      // Fall through to the single exit decision with the failing code — do NOT
      // bail out of the driver, or the open control server would keep the
      // container alive past install failure (leaking a build slot).
      agentLog(`dependency install failed (exit ${installCode})`);
      return installCode;
    }
    if (cancelled) {
      throw new Error('build cancelled');
    }

    // Install is done and its children have closed. Before spawning the trusted
    // deploy child — which carries the re-injected VOID_TOKEN + CF Access pair in
    // its env — best-effort reap any BUILDER_UID process a dependency lifecycle
    // script daemonized during install. Left alive it would be a same-uid sibling
    // of the deploy child and could read its /proc/<pid>/environ (the uid boundary
    // only blocks reading the ROOT agent's env). This narrows the surface but does
    // not seal it (a process that re-forks after the sweep survives) — see
    // killBuilderProcesses for the full limitation.
    await killBuilders();

    // Detect Yarn PnP now that install has run: a Berry PnP repo may GENERATE
    // `.pnp.cjs` during `yarn install` rather than committing it. This drives the
    // deploy RUNNER selection (`corepack yarn ...` vs bare `npx`) and the PnP
    // branch of hasLocalVoid below — both read pnpPresent post-install.
    pnpPresent = existsSync(`${WORK_DIR}/.pnp.cjs`);

    // 3. Tell the DO we're past install and into the deploy phase.
    await status('deploying');

    // 4. Run the REAL deploy via the repo-local CLI. `npx` resolves the
    //    version pinned in the repo's package.json (installed in step 2); if
    //    the repo has no local `void`, npx fetches the pinned fallback. The
    //    --no-install guard is intentionally omitted so the fallback path works.
    //    The deploy child is the ONE trusted step that needs the deploy token,
    //    so VOID_TOKEN is RE-INJECTED here on top of the scrubbed base env (it
    //    is in SCRUBBED_ENV_VARS, so it is absent from the install + any other
    //    untrusted child). The staging CF Access service token
    //    (CF_ACCESS_CLIENT_ID/SECRET) is re-injected the same way so `void deploy`
    //    can authenticate past CF Access on the staging API host (undefined off
    //    staging → dropped by sanitizeChildEnv). VOID_API_URL / VOID_PROJECT are
    //    not secrets and pass through normally. DO_LOG_URL/SOURCE_TOKEN/AGENT_TOKEN
    //    stay scrubbed — `void deploy` runs repo build code and has no business
    //    reaching the DO control plane.
    //
    //    Exposure boundary of the re-injected secrets: the framework CLI deletes
    //    CF_ACCESS_CLIENT_ID/SECRET from its own process.env right after its API
    //    client captures the Access headers and BEFORE it spawns the repo's
    //    `vite build`, so untrusted build code does NOT inherit the pair. What
    //    remains is the same-uid /proc/<deploy-pid>/environ residue (initial-env
    //    block; heap deletes don't scrub it) plus VOID_TOKEN itself, which the
    //    CLI's build child still inherits — both are the CLI trust-split
    //    escalation (build and upload share one process), a pending owner design
    //    decision, NOT addressable from this agent.
    const localVoid = hasLocalVoid();
    const fallbackVersion = voidFallbackVersion();
    // Yarn Berry PnP repos have no `node_modules`, so a bare `npx void deploy`
    // would run void OUTSIDE the PnP runtime and the `execSync` build children it
    // spawns (vite build etc.) couldn't resolve the repo's deps. Run the deploy
    // THROUGH the package manager (`corepack yarn ...`) so PnP is active and the
    // build children inherit it: `yarn void deploy` when void resolves in the PnP
    // graph (hasLocalVoid is true under PnP), else `yarn dlx void@<ver> deploy`.
    // The non-PnP path is unchanged (bare npx).
    /** @type {string} */
    let deployCmd;
    /** @type {Array<string>} */
    let deployArgs;
    if (pnpPresent) {
      deployCmd = 'corepack';
      deployArgs = localVoid
        ? ['yarn', 'void', 'deploy', '--project', project]
        : ['yarn', 'dlx', `void@${fallbackVersion}`, 'deploy', '--project', project];
      if (!localVoid) {
        agentLog(`PnP repo; falling back to yarn dlx void@${fallbackVersion}`);
      }
    } else {
      deployCmd = 'npx';
      deployArgs = localVoid
        ? ['--yes', 'void', 'deploy', '--project', project]
        : ['--yes', `void@${fallbackVersion}`, 'deploy', '--project', project];
      if (!localVoid) {
        agentLog(`no local void CLI found; falling back to npx void@${fallbackVersion}`);
      }
    }
    const deployCode = await run(deployCmd, deployArgs, {
      env: sanitizeChildEnv(process.env, {
        ...builderCacheEnv(),
        VOID_TOKEN: voidToken,
        // Re-inject the staging CF Access service token (undefined off staging,
        // which sanitizeChildEnv drops) so `void deploy` can pass CF Access.
        CF_ACCESS_CLIENT_ID: cfAccessClientId,
        CF_ACCESS_CLIENT_SECRET: cfAccessClientSecret,
      }),
    });
    agentLog(`void deploy exited with code ${deployCode}`);
    return deployCode;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    record(`[build-agent] fatal: ${message}`, 'stderr');
    return 1;
  }
}

/**
 * Termination handler for the agent process. The agent is PID 1 in the build
 * container (`CMD ["node", "/build-agent.mjs"]`, no init shim). Linux delivers a
 * signal to PID 1 ONLY when a handler is installed for it — an unhandled SIGTERM
 * to PID 1 is silently dropped. The BuildManager DO tears a build down with
 * `stop()`, which sends a bare SIGTERM and never escalates to SIGKILL on its own;
 * without this handler that SIGTERM is ignored, the container keeps running, and
 * it pins one of the fleet's global instance slots indefinitely. Installing the
 * handler is therefore what makes `stop()` work at all.
 *
 * Mirrors POST /cancel: flag the build cancelled and SIGTERM the active build
 * child (a cooperative child exits and the container terminates), then exit so the DO's
 * onStop fires and the slot is reclaimed. A child that ignores its own SIGTERM is
 * the DO's `destroy()` (SIGKILL) backstop, not ours.
 * @param {NodeJS.Signals} signal
 */
function onShutdownSignal(signal) {
  agentLog(`received ${signal}; cancelling build and shutting down`);
  cancelled = true;
  if (activeChild && activeChild.exitCode === null) {
    try {
      activeChild.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
  process.exit(1);
}

/**
 * Register the PID-1 termination handlers. Exported so a unit test can assert the
 * listeners are installed (the kernel-delivery precondition) without an actual
 * signal arriving. Called once at the top of `main()` — module import alone does
 * not register anything (the entrypoint guard keeps `main()` from running under
 * test).
 */
export function installShutdownHandlers() {
  process.on('SIGTERM', onShutdownSignal);
  process.on('SIGINT', onShutdownSignal);
}

async function main() {
  // PID-1 signal handlers FIRST: without them the kernel drops the DO's SIGTERM
  // and a torn-down build would keep running, leaking a global container slot.
  installShutdownHandlers();

  // Health/control server first so the DO's readiness probe and /cancel work
  // throughout the build.
  const server = await startControlServer();

  // Periodic best-effort log flush to the DO.
  const flushTimer = setInterval(() => {
    void flushLogs();
  }, LOG_FLUSH_MS);
  flushTimer.unref?.();

  let exitCode = 1;
  try {
    exitCode = await runBuild();
  } finally {
    clearInterval(flushTimer);
    // Final flush so the last lines reach the DO (best-effort) before exit.
    await flushLogs();
    // Close the control server unconditionally: its open listening socket would
    // otherwise keep the Node event loop alive after the build resolves, so the
    // container would never reach `process.exit` and would leak a build slot
    // until the DO's `sleepAfter` ceiling (or, for unlimited plans with no
    // timeout alarm, far longer).
    await closeControlServer(server);
  }

  // The DO's onStop maps exit 0 -> complete, non-zero -> failed. Run on EVERY
  // path (install/download/deploy failure and success alike) so the container
  // always terminates.
  process.exit(exitCode);
}

// Only auto-run when executed as the container entrypoint. When imported (e.g.
// unit tests exercising `sanitizeChildEnv`/`runBuild`), the module exposes its
// helpers without starting the control server or spawning any build steps.
const isEntrypoint = argv[1] && import.meta.url === pathToFileURL(argv[1]).href;
if (isEntrypoint) {
  main().catch((err) => {
    // Last-resort guard — main() already wraps its body, but never let an
    // unhandled rejection leave the container hanging without an exit code.
    console.error(err);
    process.exit(1);
  });
}
