import { DurableObject } from 'cloudflare:workers';
import { CronExpressionParser } from 'cron-parser';
import type { ApiEnv } from './env';

interface CronState {
  workerName: string;
  schedules: Array<{ name: string; cron: string }>;
  proxyToken?: string;
}

/** Thrown when the worker script cannot be reached (deleted/evicted). */
class WorkerUnreachableError extends Error {}

/**
 * Convert a CF/Quartz-style cron expression to Unix-style for cron-parser.
 *
 * Cloudflare uses Quartz day-of-week numbering (1=Sun … 7=Sat).
 * cron-parser uses Unix convention (0=Sun … 6=Sat, 7=Sun).
 * This only affects numeric values in the DOW field — abbreviations (MON, FRI)
 * are unambiguous and passed through unchanged.
 */
export function cfCronToUnix(expr: string): string {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return expr;
  }

  fields[4] = fields[4]
    .split(',')
    .map((part) => {
      // Handle range with optional step: "2-6/2" → "1-5/2"
      const [rangeOrValue, step] = part.split('/');
      const stepSuffix = step != null ? `/${step}` : '';

      if (rangeOrValue === '*') {
        return `*${stepSuffix}`;
      }

      // Handle range: "2-6" → "1-5"
      if (rangeOrValue.includes('-')) {
        const [start, end] = rangeOrValue.split('-').map((v) => shiftDow(v));
        return `${start}-${end}${stepSuffix}`;
      }

      // Single value (may have L/# suffix)
      return `${shiftDow(rangeOrValue)}${stepSuffix}`;
    })
    .join(',');

  return fields.join(' ');
}

function shiftDow(value: string): string {
  // Preserve abbreviations (MON, FRI, etc.) and L/# suffixes
  const match = value.match(/^(\d+)(.*)/);
  if (!match) {
    return value;
  } // abbreviation like MON, SUN
  const num = Math.max(0, parseInt(match[1], 10) - 1);
  return `${num}${match[2]}`;
}

/** Check if a cron expression matches the given minute. */
export function cronMatchesMinute(cronExpr: string, now: number): boolean {
  try {
    // Add 1ms so prev() returns the current minute when now is exactly on the boundary.
    // Cron resolution is per-minute so this is safe.
    const interval = CronExpressionParser.parse(cfCronToUnix(cronExpr), {
      currentDate: new Date(now + 1),
      tz: 'UTC',
    });
    const prev = interval.prev().toDate().getTime();
    const nowMinute = Math.floor(now / 60000) * 60000;
    return prev >= nowMinute && prev < nowMinute + 60000;
  } catch {
    return false;
  }
}

/** Compute the earliest next fire time across all schedules. Returns null if none. */
export function getNextFireTime(schedules: Array<{ cron: string }>, now: number): number | null {
  let earliest = Infinity;
  for (const s of schedules) {
    try {
      const interval = CronExpressionParser.parse(cfCronToUnix(s.cron), {
        currentDate: new Date(now),
        tz: 'UTC',
      });
      const next = interval.next().toDate().getTime();
      if (next < earliest) {
        earliest = next;
      }
    } catch {
      // Skip invalid cron expressions
    }
  }
  return earliest < Infinity ? earliest : null;
}

const MAX_CONSECUTIVE_FAILURES = 5;

export class CronScheduler extends DurableObject<ApiEnv['Bindings']> {
  private state: CronState | null = null;

  private async getState(): Promise<CronState | null> {
    if (this.state) {
      return this.state;
    }
    const stored = await this.ctx.storage.get<CronState>('state');
    this.state = stored ?? null;
    return this.state;
  }

  private async saveState(state: CronState): Promise<void> {
    this.state = state;
    await this.ctx.storage.put('state', state);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST' && path === '/sync') {
      return this.handleSync(request);
    }
    if (request.method === 'POST' && path === '/clear') {
      return this.handleClear();
    }
    if (request.method === 'GET' && path === '/status') {
      return this.handleStatus();
    }

    return new Response('not found', { status: 404 });
  }

  private async handleSync(request: Request): Promise<Response> {
    const body = await request.json<CronState>();
    await this.saveState(body);
    await this.ctx.storage.put('failures', 0);
    await this.scheduleNextAlarm();
    return Response.json({ ok: true });
  }

  private async handleClear(): Promise<Response> {
    this.state = null;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    return Response.json({ ok: true });
  }

  private async handleStatus(): Promise<Response> {
    const state = await this.getState();
    const alarm = await this.ctx.storage.getAlarm();
    const failures = (await this.ctx.storage.get<number>('failures')) ?? 0;
    // Omit proxyToken from status response to avoid leaking secrets
    const { proxyToken: _, ...safeState } = state ?? {};
    return Response.json({ state: state ? safeState : null, nextAlarm: alarm, failures });
  }

  async alarm(): Promise<void> {
    const state = await this.getState();
    if (!state || state.schedules.length === 0) {
      return;
    }

    // State created before the proxyToken fix lacks auth credentials.
    // Skip invocation to avoid sending unauthenticated requests — the next
    // deploy will resync state with the token.
    if (!state.proxyToken) {
      console.warn(
        `CronScheduler: missing proxyToken for ${state.workerName}, skipping until next deploy resync`,
      );
      return;
    }

    const now = Date.now();
    const matching = state.schedules.filter((s) => cronMatchesMinute(s.cron, now));

    if (matching.length === 0) {
      await this.scheduleNextAlarm();
      return;
    }

    const results = await Promise.allSettled(
      matching.map((s) => this.invokeWorker(state.workerName, s.cron, now, state.proxyToken)),
    );

    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        console.error(
          `cron ${matching[i].name} (${matching[i].cron}) failed for ${state.workerName}:`,
          (results[i] as PromiseRejectedResult).reason,
        );
      }
    }

    // Only count toward circuit breaker when the worker itself is unreachable
    // (deleted/evicted), not when the handler returns an application-level error.
    const allUnreachable = results.every(
      (r) => r.status === 'rejected' && r.reason instanceof WorkerUnreachableError,
    );
    if (allUnreachable) {
      const failures = ((await this.ctx.storage.get<number>('failures')) ?? 0) + 1;
      await this.ctx.storage.put('failures', failures);
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(
          `CronScheduler: ${failures} consecutive failures for ${state.workerName}, auto-clearing`,
        );
        await this.handleClear();
        return;
      }
    } else {
      await this.ctx.storage.put('failures', 0);
    }

    await this.scheduleNextAlarm();
  }

  private async invokeWorker(
    workerName: string,
    cron: string,
    scheduledTime: number,
    proxyToken?: string,
  ): Promise<void> {
    let res: Response;
    try {
      const worker = this.env.DISPATCH.get(workerName);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (proxyToken) {
        headers['x-void-internal'] = proxyToken;
      }
      const body = JSON.stringify({ cron, scheduledTime });
      res = await worker.fetch(
        new Request('https://internal/__void/scheduled', {
          method: 'POST',
          headers,
          body,
        }),
      );
      // Legacy: fall back for workers deployed before the /__void/ migration.
      // TODO: remove once all deployed workers use /__void/* paths. See #88
      if (res.status === 404) {
        res = await worker.fetch(
          new Request('https://internal/__scheduled', {
            method: 'POST',
            headers,
            body,
          }),
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Only classify as unreachable when the worker script is definitively gone.
      // Other thrown errors (CPU limit, transient infra, compilation) mean the
      // worker exists or the failure is transient — don't count toward circuit breaker.
      if (msg.includes('Worker not found')) {
        throw new WorkerUnreachableError(msg);
      }
      throw new Error(msg);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status}: ${text}`);
    }
  }

  private async scheduleNextAlarm(): Promise<void> {
    const state = await this.getState();
    if (!state || state.schedules.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const next = getNextFireTime(state.schedules, Date.now());
    if (next != null) {
      await this.ctx.storage.setAlarm(next);
    }
  }
}
