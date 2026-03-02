import { DurableObject } from "cloudflare:workers";
import { CronExpressionParser } from "cron-parser";
import type { ApiEnv } from "./env";

interface CronState {
  workerName: string;
  schedules: { name: string; cron: string }[];
}

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
  if (fields.length !== 5) return expr;

  fields[4] = fields[4]
    .split(",")
    .map((part) => {
      // Handle range with optional step: "2-6/2" → "1-5/2"
      const [rangeOrValue, step] = part.split("/");
      const stepSuffix = step != null ? `/${step}` : "";

      if (rangeOrValue === "*") return `*${stepSuffix}`;

      // Handle range: "2-6" → "1-5"
      if (rangeOrValue.includes("-")) {
        const [start, end] = rangeOrValue.split("-").map((v) => shiftDow(v));
        return `${start}-${end}${stepSuffix}`;
      }

      // Single value (may have L/# suffix)
      return `${shiftDow(rangeOrValue)}${stepSuffix}`;
    })
    .join(",");

  return fields.join(" ");
}

function shiftDow(value: string): string {
  // Preserve abbreviations (MON, FRI, etc.) and L/# suffixes
  const match = value.match(/^(\d+)(.*)/);
  if (!match) return value; // abbreviation like MON, SUN
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
      tz: "UTC",
    });
    const prev = interval.prev().toDate().getTime();
    const nowMinute = Math.floor(now / 60000) * 60000;
    return prev >= nowMinute && prev < nowMinute + 60000;
  } catch {
    return false;
  }
}

/** Compute the earliest next fire time across all schedules. Returns null if none. */
export function getNextFireTime(schedules: { cron: string }[], now: number): number | null {
  let earliest = Infinity;
  for (const s of schedules) {
    try {
      const interval = CronExpressionParser.parse(cfCronToUnix(s.cron), {
        currentDate: new Date(now),
        tz: "UTC",
      });
      const next = interval.next().toDate().getTime();
      if (next < earliest) earliest = next;
    } catch {
      // Skip invalid cron expressions
    }
  }
  return earliest < Infinity ? earliest : null;
}

export class CronScheduler extends DurableObject<ApiEnv["Bindings"]> {
  private state: CronState | null = null;

  private async getState(): Promise<CronState | null> {
    if (this.state) return this.state;
    const stored = await this.ctx.storage.get<CronState>("state");
    this.state = stored ?? null;
    return this.state;
  }

  private async saveState(state: CronState): Promise<void> {
    this.state = state;
    await this.ctx.storage.put("state", state);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "POST" && path === "/sync") {
      return this.handleSync(request);
    }
    if (request.method === "POST" && path === "/clear") {
      return this.handleClear();
    }
    if (request.method === "GET" && path === "/status") {
      return this.handleStatus();
    }

    return new Response("not found", { status: 404 });
  }

  private async handleSync(request: Request): Promise<Response> {
    const body = await request.json<CronState>();
    await this.saveState(body);
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
    return Response.json({ state, nextAlarm: alarm });
  }

  async alarm(): Promise<void> {
    const state = await this.getState();
    if (!state || state.schedules.length === 0) return;

    const now = Date.now();

    const invocations = state.schedules
      .filter((s) => cronMatchesMinute(s.cron, now))
      .map((s) =>
        this.invokeWorker(state.workerName, s.cron, now).catch((err) => {
          console.error(`cron ${s.name} (${s.cron}) failed for ${state.workerName}:`, err);
        }),
      );

    await Promise.allSettled(invocations);
    await this.scheduleNextAlarm();
  }

  private async invokeWorker(
    workerName: string,
    cron: string,
    scheduledTime: number,
  ): Promise<void> {
    const worker = this.env.DISPATCH.get(workerName);
    const res = await worker.fetch(
      new Request("https://internal/__scheduled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cron, scheduledTime }),
      }),
    );
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
