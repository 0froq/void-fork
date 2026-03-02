# Platform Cron Scheduler Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a DO-based cron scheduler so user-defined cron jobs fire when deployed to Cloudflare Workers for Platforms dispatch namespaces.

**Architecture:** A `CronScheduler` Durable Object (one per project) on the API worker evaluates cron expressions and invokes user workers via the DISPATCH binding. User workers receive cron invocations via a `/__scheduled` HTTP route (same relay pattern as `/__queue` for queues). The deploy flow syncs schedules to the DO on each deploy.

**Tech Stack:** Cloudflare Durable Objects (alarms), `cron-parser` npm package, framework codegen (compile.ts + wrapper.ts)

---

### Task 1: Add `cron-parser` dependency to API package

**Files:**

- Modify: `packages/api/package.json`

**Step 1: Check latest version**

Run: `npm view cron-parser version`
Expected: `5.5.0` (or similar)

**Step 2: Add dependency**

Run: `pnpm -C packages/api add cron-parser@5.5.0`

**Step 3: Verify install**

Run: `pnpm install`
Expected: Clean install, no errors

---

### Task 2: Create `CronScheduler` Durable Object

**Files:**

- Create: `packages/api/src/cron-scheduler.ts`
- Modify: `packages/api/src/env.ts` (add `CRON_SCHEDULER` binding)
- Modify: `packages/api/src/index.ts` (export new DO class)

**Step 1: Write the `CronScheduler` DO**

Create `packages/api/src/cron-scheduler.ts`:

```typescript
import { DurableObject } from "cloudflare:workers";
import { parseExpression } from "cron-parser";
import type { ApiEnv } from "./env";

interface CronState {
  workerName: string;
  schedules: { name: string; cron: string }[];
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

    // Fire all crons that match this minute
    const invocations = state.schedules
      .filter((s) => this.cronMatchesMinute(s.cron, now))
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

  private cronMatchesMinute(cronExpr: string, now: number): boolean {
    try {
      const interval = parseExpression(cronExpr, { currentDate: new Date(now), utc: true });
      const prev = interval.prev().getTime();
      // "prev" is the most recent fire time <= now. If it's within this minute, it matches.
      const nowMinute = Math.floor(now / 60000) * 60000;
      return prev >= nowMinute && prev < nowMinute + 60000;
    } catch {
      return false;
    }
  }

  private async scheduleNextAlarm(): Promise<void> {
    const state = await this.getState();
    if (!state || state.schedules.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const now = Date.now();
    let earliest = Infinity;

    for (const s of state.schedules) {
      try {
        const interval = parseExpression(s.cron, { currentDate: new Date(now), utc: true });
        const next = interval.next().getTime();
        if (next < earliest) earliest = next;
      } catch {
        // Skip invalid cron expressions
      }
    }

    if (earliest < Infinity) {
      await this.ctx.storage.setAlarm(earliest);
    }
  }
}
```

**Step 2: Add `CRON_SCHEDULER` to env bindings**

In `packages/api/src/env.ts`, add after the `USAGE_COUNTER` line:

```typescript
CRON_SCHEDULER: DurableObjectNamespace;
```

**Step 3: Export `CronScheduler` from index.ts**

In `packages/api/src/index.ts`, add import and export:

```typescript
import { CronScheduler } from "./cron-scheduler";
export { CronScheduler };
```

(next to the existing `export { UsageCounter }`)

**Step 4: Verify typecheck**

Run: `pnpm -C packages/api check`
Expected: No type errors

---

### Task 3: Update wrangler.jsonc for CronScheduler DO

**Files:**

- Modify: `packages/api/wrangler.jsonc`

**Step 1: Add DO binding and migration**

In the top-level `durable_objects.bindings` array, add:

```jsonc
{ "name": "CRON_SCHEDULER", "class_name": "CronScheduler" }
```

In the `migrations` array, add:

```jsonc
{ "tag": "v2", "new_classes": ["CronScheduler"] }
```

**Step 2: Add to staging environment**

In `env.staging.durable_objects.bindings`, add the same binding:

```jsonc
{ "name": "CRON_SCHEDULER", "class_name": "CronScheduler" }
```

---

### Task 4: Update deploy flow to sync cron schedules to DO

**Files:**

- Modify: `packages/api/src/routes/deploy.ts`

**Step 1: Remove useless `triggers` from upload metadata**

At line 411-414 in `deploy.ts`, remove the `triggers` property from the `metadata` object entirely. Delete:

```typescript
triggers:
  manifest.schedules && manifest.schedules.length > 0
    ? { crons: manifest.schedules.map((schedule) => schedule.cron) }
    : undefined,
```

**Step 2: Add cron scheduler sync after queue setup**

After the queue setup block (around line 489), add a new section:

```typescript
// 2c. Sync cron schedules to CronScheduler DO
currentStep = "cron_setup";
const cronSchedulerId = c.env.CRON_SCHEDULER.idFromName(projectId);
const cronSchedulerStub = c.env.CRON_SCHEDULER.get(cronSchedulerId);

if (manifest.schedules && manifest.schedules.length > 0) {
  await cronSchedulerStub.fetch(
    new Request("https://do/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workerName,
        schedules: manifest.schedules,
      }),
    }),
  );
} else {
  // Clear any previously configured crons
  await cronSchedulerStub.fetch(new Request("https://do/clear", { method: "POST" }));
}
```

**Step 3: Verify typecheck**

Run: `pnpm -C packages/api check`
Expected: No type errors

---

### Task 5: Add `/__scheduled` route to framework (compile.ts)

**Files:**

- Modify: `framework/packages/void/src/router/compile.ts`

**Step 1: Add `/__scheduled` POST route generation**

In `compile.ts`, after the `scheduled()` function generation block (line 384) and before the `/__queue` route block (line 390), add:

```typescript
if (scan.jobs.length > 0) {
  lines.push('app.post("/__scheduled", async (c) => {');
  lines.push("  const { cron, scheduledTime } = await c.req.json();");
  lines.push("  const controller = { cron, scheduledTime, noRetry() {} };");
  lines.push("  await scheduled(controller, c.env, c.executionCtx);");
  lines.push("  return c.json({ ok: true });");
  lines.push("});");
  lines.push("");
}
```

This reuses the already-generated `scheduled()` function (the cron dispatcher) and wraps it in an HTTP endpoint.

**Step 2: Verify typecheck**

Run: `pnpm -C framework check`
Expected: No type errors

---

### Task 6: Add `/__scheduled` route to wrapper entry (wrapper.ts)

**Files:**

- Modify: `framework/packages/void/src/cli/wrapper.ts`

The wrapper is used for deploy builds (distinct from the dev server compile.ts path). The wrapper's `entry.ts` delegates `scheduled` directly to `handleScheduled`. We need an HTTP-accessible path too.

**Step 1: Update `generateWrapperSource()` to add a fetch wrapper**

The wrapper's generated `entry.ts` currently looks like:

```typescript
import original from "__ORIGINAL_WORKER__";
import { handleScheduled } from "./scheduled.ts";
export default {
  fetch: original.fetch,
  scheduled: handleScheduled,
};
```

Update it so the fetch handler intercepts `/__scheduled` requests:

```typescript
import original from "__ORIGINAL_WORKER__";
import { handleScheduled } from "./scheduled.ts";

async function wrappedFetch(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/__scheduled") {
    try {
      const { cron, scheduledTime } = await request.json();
      const controller = { cron, scheduledTime, noRetry() {} };
      await handleScheduled(controller, env, ctx);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
  return original.fetch(request, env, ctx);
}

export default {
  fetch: wrappedFetch,
  scheduled: handleScheduled,
};
```

In `generateWrapperSource()`, modify the code generation to produce this when `features.crons.length > 0`.

**Step 2: Verify typecheck**

Run: `pnpm -C framework check`
Expected: No type errors

---

### Task 7: Write tests

**Files:**

- Create: `packages/api/test/unit/cron-scheduler.test.ts`

**Step 1: Write unit tests for `cronMatchesMinute` and alarm scheduling logic**

Since the DO uses private methods, test the cron matching logic by extracting it or testing through the DO's public interface. Key test cases:

```typescript
import { describe, it, expect } from "vitest";

// Test cron expression evaluation via the DO's alarm behavior
describe("CronScheduler", () => {
  it("should return schedules on /status after /sync", async () => {
    // Create DO stub, POST /sync with schedules, GET /status, verify state
  });

  it("should clear state and alarm on /clear", async () => {
    // POST /sync, then POST /clear, verify GET /status returns null state
  });

  it("should invoke worker on alarm when cron matches", async () => {
    // Requires mocking DISPATCH binding
    // Sync a schedule with "* * * * *", trigger alarm, verify fetch was called
  });

  it("should schedule alarm for next fire time after sync", async () => {
    // POST /sync with "0 * * * *", verify alarm is set ~next hour
  });
});
```

The exact test implementation depends on the existing test infrastructure (check `packages/api/test/` for patterns — likely uses PGlite + miniflare `env` stubs).

**Step 2: Run tests**

Run: `pnpm -C packages/api test`
Expected: All tests pass

---

### Task 8: Verify end-to-end and clean up

**Step 1: Build all packages**

Run: `pnpm -r build`
Expected: Clean build

**Step 2: Lint and format**

Run: `pnpm lint && pnpm fmt`
Expected: No errors or warnings

**Step 3: Typecheck**

Run: `pnpm check`
Expected: No type errors

**Step 4: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

**Step 5: Commit**

Stage and commit all changes (after user confirmation).
