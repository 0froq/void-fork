/**
 * Error thrown when a promise wrapped by {@link withTimeout} does not settle
 * within its allotted time. The `label` identifies which awaited operation
 * timed out (e.g. `'kv:get'`, `'r2:head'`) for logging/observability.
 */
export class DispatchTimeoutError extends Error {
  readonly label: string;

  constructor(label: string) {
    super(`Dispatch operation timed out: ${label}`);
    this.name = 'DispatchTimeoutError';
    this.label = label;
  }
}

/**
 * Bounds an awaited `promise` so the request path never blocks indefinitely.
 *
 * - When `ms` is not a positive finite number (`<= 0`, `NaN`, or `Infinity`),
 *   the original `promise` is returned unchanged (escape hatch — no timer).
 * - Otherwise the `promise` races a timer that rejects with a
 *   {@link DispatchTimeoutError} after `ms` milliseconds.
 * - The timer is cleared as soon as `promise` settles (resolve **or** reject),
 *   so it never fires late and leaves no dangling handle. A fast rejection
 *   propagates the ORIGINAL reason (not a timeout error).
 * - If the timer wins, the result rejects with a `DispatchTimeoutError`. The
 *   underlying `promise` keeps running to completion in the background; we do
 *   not attempt to cancel the in-flight KV/R2 work.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (!(ms > 0) || !Number.isFinite(ms)) {
    return promise;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DispatchTimeoutError(label));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Resolve the timeout budget (ms) from the raw `DISPATCH_TIMEOUT_MS` env value.
 *
 * - Unset (`undefined`) → the `fallback` default (10s).
 * - Any explicitly-provided value is passed through via `Number(...)` UNCHANGED —
 *   including `'0'`, negatives, empty string, and non-numeric strings (`NaN`). This
 *   preserves the escape hatch: {@link withTimeout} treats any non-positive/non-finite
 *   budget as "no timer", so an operator can disable the bounded paths by setting
 *   `DISPATCH_TIMEOUT_MS='0'` WITHOUT a redeploy. A blanket `|| fallback` would defeat
 *   this by collapsing every disabling value back to the default.
 */
export function resolveTimeoutMs(raw: string | undefined, fallback = 10000): number {
  return raw === undefined ? fallback : Number(raw);
}
