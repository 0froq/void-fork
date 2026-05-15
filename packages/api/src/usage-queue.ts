import { createDb, getUser } from './db.ts';
import type { ApiEnv } from './env.ts';
import { getPlanLimits } from './tiers.ts';
import type { UsageEvent } from './usage-counter.ts';

export function groupEventsByUser(
  events: ReadonlyArray<UsageEvent>,
): Map<string, ReadonlyArray<UsageEvent>> {
  const grouped = new Map<string, Array<UsageEvent>>();
  for (const event of events) {
    const existing = grouped.get(event.userId);
    if (existing) {
      existing.push(event);
    } else {
      grouped.set(event.userId, [event]);
    }
  }
  return grouped;
}

export async function processUsageEventBatch(
  batch: MessageBatch<unknown>,
  env: ApiEnv['Bindings'],
): Promise<void> {
  const events = batch.messages.map((m) => m.body as UsageEvent);
  const grouped = groupEventsByUser(events);
  const db = createDb(env.HYPERDRIVE.connectionString);

  const results = await Promise.allSettled(
    [...grouped.entries()].map(async ([userId, userEvents]) => {
      // Look up user plan (skip DO call for unlimited plans)
      const user = await getUser(db, userId);
      if (!user) {
        return;
      } // Unknown user, skip
      const plan = user.plan ?? 'free';
      const limits = getPlanLimits(plan);
      if (limits.requestsPerMonth === 0) {
        return;
      } // Unlimited plan, skip DO

      // Forward to DO
      const doId = env.USAGE_COUNTER.idFromName(userId);
      const stub = env.USAGE_COUNTER.get(doId);
      const res = await stub.fetch(
        new Request('https://do/record', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ events: userEvents, plan, userId }),
        }),
      );

      if (!res.ok) {
        throw new Error(`DO /record failed for user ${userId}: ${res.status}`);
      }
    }),
  );

  // If any UsageCounter DO calls failed, retry the whole batch
  // Route 5xx events only on the ack path to avoid double-counting on redelivery
  const failures = results.filter((r) => r.status === 'rejected');
  if (failures.length > 0) {
    batch.retryAll();
  } else {
    // Best-effort: route 5xx events to ErrorAlertMonitor (failures don't block ack)
    const errorEvents = events.filter((e) => e.status !== undefined && e.status >= 500);
    if (errorEvents.length > 0) {
      const errorsByProject = new Map<string, { count: number; userId: string; slug: string }>();
      for (const event of errorEvents) {
        const existing = errorsByProject.get(event.projectId);
        if (existing) {
          existing.count++;
        } else {
          errorsByProject.set(event.projectId, {
            count: 1,
            userId: event.userId,
            slug: event.slug,
          });
        }
      }

      await Promise.allSettled(
        [...errorsByProject.entries()].map(async ([projectId, { count, userId, slug }]) => {
          const doId = env.ERROR_ALERT_MONITOR.idFromName(projectId);
          const stub = env.ERROR_ALERT_MONITOR.get(doId);
          const res = await stub.fetch(
            new Request('https://do/record', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ projectId, count, userId, slug }),
            }),
          );
          if (!res.ok) {
            console.error(
              `[error-alert] DO /record failed for project ${projectId}: ${res.status}`,
            );
          }
        }),
      );
    }

    batch.ackAll();
  }
}
