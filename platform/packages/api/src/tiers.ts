import {
  PLAN_LIMITS as BUILTIN_PLAN_LIMITS,
  type PlanLimits,
  type PlanId,
  BUILD_INSTANCE_FREE,
  BUILD_INSTANCE_LARGE,
  type BuildInstanceType,
} from '@void/platform/plans';
export const PLAN_LIMITS: Record<string, PlanLimits> = BUILTIN_PLAN_LIMITS;
export { BUILD_INSTANCE_FREE, BUILD_INSTANCE_LARGE };
export type { PlanId, PlanLimits, BuildInstanceType };

/** Static deployments use a fixed retention limit across all tiers (KV/R2-backed, not WfP). */
export const STATIC_RETENTION_LIMIT = 100;

/** Returns plan limits, defaulting to free tier for unknown plans. */
export function getPlanLimits(plan: string): PlanLimits {
  return Object.hasOwn(PLAN_LIMITS, plan) ? PLAN_LIMITS[plan] : PLAN_LIMITS.free;
}

/**
 * Returns the build container instance type for a plan, defaulting to the free
 * (smaller, cheaper) container.
 *
 * This value is BOTH the persisted size-of-record (written to the
 * `builds.instance_type` DB column) AND the routing key that selects which
 * container-enabled DO class — and thus which static container size — the build
 * runs on. `@cloudflare/containers@0.3.3` has no per-start sizing, so each size
 * is a distinct DO class with a fixed `instance_type` in wrangler.jsonc;
 * `buildManagerNamespace` (build-namespace.ts) maps this value to the class:
 * `BUILD_INSTANCE_LARGE` → `BuildManagerLarge` (standard-4), everything else →
 * the base `BuildManager` (standard-3).
 */
export function getBuildInstanceType(plan: PlanId): BuildInstanceType {
  switch (plan) {
    case 'free':
      return BUILD_INSTANCE_FREE;
    case 'solo':
    case 'pro':
    case 'sponsored':
    case 'custom':
      return BUILD_INSTANCE_LARGE;
    default:
      return BUILD_INSTANCE_FREE;
  }
}

/** Checks if current usage is within the limit. 0 = unlimited. */
export function isWithinLimit(limit: number, current: number): boolean {
  return limit === 0 || current < limit;
}

/**
 * Returns the start of the user's current billing period based on their
 * signup anniversary day. Clamps to the last day of the month for short
 * months (e.g. signup Jan 31 → Feb 28 in non-leap years).
 */
export function getCurrentBillingPeriodStart(billingCycleStart: string | null | undefined): Date {
  // Handle missing or invalid billing_cycle_start (e.g. legacy rows before column existed)
  if (!billingCycleStart) {
    return new Date();
  }
  // Normalize timestamp format (also handles legacy rows with space separator, no Z)
  const normalized = billingCycleStart.includes('T')
    ? billingCycleStart
    : billingCycleStart.replace(' ', 'T') + 'Z';
  const signup = new Date(normalized);
  if (isNaN(signup.getTime())) {
    return new Date();
  }
  const anchorDay = signup.getUTCDate();
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  // Try current month first
  const lastDayThisMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const dayThisMonth = Math.min(anchorDay, lastDayThisMonth);
  const candidate = new Date(Date.UTC(year, month, dayThisMonth));

  if (candidate <= now) {
    return candidate;
  }

  // Fall back to previous month
  const lastDayPrevMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const dayPrevMonth = Math.min(anchorDay, lastDayPrevMonth);
  return new Date(Date.UTC(year, month - 1, dayPrevMonth));
}
