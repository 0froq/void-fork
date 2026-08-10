// Type declarations for the container build agent. `build-agent.mjs` is plain
// JavaScript (this package has no `allowJs`), so NodeNext pairs it with this
// `.d.mts` — letting the unit test import the exported helpers without a
// `@ts-expect-error`. Only the test-exercised surface is declared; the agent's
// runtime behavior lives in build-agent.mjs. Not copied into the container image
// (the Dockerfile copies build-agent.mjs only).

export const SCRUBBED_ENV_VARS: ReadonlyArray<string>;

/** Non-root uid/gid/home the untrusted build children run under (matches Dockerfile). */
export const BUILDER_UID: number;
export const BUILDER_GID: number;
export const BUILDER_HOME: string;

/** Cache/HOME env overrides so the non-root builder has writable package-manager caches. */
export function builderCacheEnv(): Record<string, string>;

/** `CI=true` for every build child, so interactive CLIs render CI-safe (non-animated) output. */
export function nonInteractiveEnv(): Record<string, string>;

/** Fallback `void` CLI version when BuildManager injects no `VOID_CLI_VERSION`. */
export const DEFAULT_VOID_CLI_VERSION: string;

/** spawn() options for an untrusted child: WORK_DIR cwd, piped stdio, non-root uid/gid. */
export function childSpawnOptions(): {
  cwd: string;
  stdio: ReadonlyArray<'ignore' | 'pipe' | 'inherit'>;
  uid: number;
  gid: number;
};

/** Hard cap on the retained in-memory PULL log buffer (`record` evicts past it). */
export const MAX_BUFFERED_LOG_LINES: number;

/** Hard cap on the unflushed PUSH batch (`record` evicts past it; bounds flood OOM). */
export const MAX_PENDING_LOG_LINES: number;
export const MAX_LOG_RESPONSE_BYTES: number;
export const MAX_BUFFERED_LOG_BYTES: number;
export function clearBufferedLogLines(): void;
export const MAX_LOG_RESPONSE_LINES: number;

/** Force-flush threshold for `pipeStream`'s unterminated partial-line tail. */
export const MAX_PARTIAL_LINE_CHARS: number;

/**
 * Convert a readable byte stream into line-delimited `record()` calls. Splits on
 * CR / LF / CRLF (so `\r` progress frames flush live) with a byte-capped tail.
 */
export function pipeStream(source: NodeJS.ReadableStream, stream: 'stdout' | 'stderr'): void;

/** Append a log line to the bounded PULL buffer (+ pending push batch + stderr). */
export function record(
  line: string,
  stream: 'stdout' | 'stderr',
  lineEnding?: 'cr' | 'lf' | 'crlf' | 'none',
): void;

/** Single-flight, drain-to-empty best-effort flush of pending lines to the DO. */
export function flushLogs(): Promise<void>;

/** Test-only: snapshot of the retained PULL buffer. */
export function getBufferedLogLines(): ReadonlyArray<{
  seq: number;
  line: string;
  stream: 'stdout' | 'stderr';
  ts: number;
  lineEnding?: 'cr' | 'lf' | 'crlf' | 'none';
}>;

/** Test-only: current length of the unflushed PUSH batch. */
export function getPendingLogLineCount(): number;

/**
 * Returns a copy of `baseEnv` with the control-plane vars in `SCRUBBED_ENV_VARS`
 * removed, then `extra` applied — the env handed to untrusted child processes.
 */
export function sanitizeChildEnv(
  baseEnv: Record<string, string | undefined>,
  extra?: Record<string, string | undefined>,
): Record<string, string>;

/** Start the agent's HTTP control server (health / `GET /logs` PULL / `POST /cancel`). */
export function startControlServer(port?: number): Promise<import('node:http').Server>;

/**
 * Test-only: highest `lastSeq` already served on `GET /logs`. Diagnostic only —
 * bytes leaving this process is not proof the DO stored them, so the exit barrier
 * waits on `getAckedLogSeq` instead.
 */
export function getServedLogSeq(): number;

/**
 * Test-only: highest `since` cursor the DO's puller has sent us. The DO advances
 * that cursor only after a successful ingest, so it is the drain acknowledgement.
 */
export function getAckedLogSeq(): number;

/** Bounds of the exit-time drain barrier (see `waitForLogDrain`). */
export const LOG_DRAIN_IDLE_TIMEOUT_MS: number;
export const LOG_DRAIN_ABSOLUTE_TIMEOUT_MS: number;
export const LOG_DRAIN_POLL_MS: number;

/**
 * Bounded exit-time barrier: waits until the DO's `GET /logs` puller has ACKED
 * every recorded line. Resolves true when drained, false at the deadline.
 */
export function waitForLogDrain(options?: {
  timeoutMs?: number;
  idleTimeoutMs?: number;
  pollMs?: number;
  served?: () => number;
  recorded?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<boolean>;

/** Best-effort, idempotent, null-safe close of the agent's HTTP control server. */
export function closeControlServer(server: unknown): Promise<void>;

/**
 * The container's exit path: drain barrier, then close the control server.
 * Deliberately does NOT flush — the agent's `POST /logs` push has no route to the
 * DO, so awaiting it could only spend the DO's drain grace. Exported so the
 * ORDERING is unit-testable (`main()` is not).
 */
export function finishBuildLogging(
  server: unknown,
  drainOptions?: {
    timeoutMs?: number;
    idleTimeoutMs?: number;
    pollMs?: number;
    served?: () => number;
    recorded?: () => number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<void>;

/**
 * Parse the real uid from a `/proc/<pid>/status` blob (first field of the `Uid:`
 * line); null when absent. Used by the pre-deploy builder-process reaper.
 */
export function parseProcStatusUid(statusText: string): number | null;

/**
 * Register the PID-1 SIGTERM/SIGINT handlers so the kernel delivers the DO's
 * `stop()` signal to the agent (PID 1) instead of dropping it. Called at the top
 * of `main()`; exported so a test can assert the listeners are installed.
 */
export function installShutdownHandlers(): void;

export interface RunBuildDeps {
  downloadSource?: () => Promise<void>;
  resolveInstall?: () => { manager: string; cmd: string; args: ReadonlyArray<string> };
  runChild?: (
    cmd: string,
    args: ReadonlyArray<string>,
    opts?: { env?: Record<string, string | undefined> },
  ) => Promise<number>;
  reportStatus?: (status: string) => Promise<void>;
  hasLocalVoid?: () => boolean;
  chownWorkDir?: () => Promise<void>;
  killBuilderProcesses?: () => Promise<void>;
}

/** Runs the build pipeline and always resolves to a process exit code. */
export function runBuild(deps?: RunBuildDeps): Promise<number>;
