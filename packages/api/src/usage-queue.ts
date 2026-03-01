import type { ApiEnv } from "./env";
import { createDb, getUser } from "./db";
import { getPlanLimits } from "./tiers";
import type { UsageEvent } from "./usage-counter";

export function groupEventsByUser(events: UsageEvent[]): Map<string, UsageEvent[]> {
  const grouped = new Map<string, UsageEvent[]>();
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
  env: ApiEnv["Bindings"],
): Promise<void> {
  const events = batch.messages.map((m) => m.body as UsageEvent);
  const grouped = groupEventsByUser(events);
  const db = createDb(env.HYPERDRIVE.connectionString);

  const results = await Promise.allSettled(
    [...grouped.entries()].map(async ([userId, userEvents]) => {
      // Look up user plan (skip DO call for unlimited plans)
      const user = await getUser(db, userId);
      if (!user) return; // Unknown user, skip
      const plan = user.plan ?? "free";
      const limits = getPlanLimits(plan);
      if (limits.requestsPerMonth === 0) return; // Unlimited plan, skip DO

      // Forward to DO
      const doId = env.USAGE_COUNTER.idFromName(userId);
      const stub = env.USAGE_COUNTER.get(doId);
      const res = await stub.fetch(
        new Request("https://do/record", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ events: userEvents, plan, userId }),
        }),
      );

      if (!res.ok) {
        throw new Error(`DO /record failed for user ${userId}: ${res.status}`);
      }
    }),
  );

  // If any DO calls failed, retry the whole batch
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    batch.retryAll();
  } else {
    batch.ackAll();
  }
}
