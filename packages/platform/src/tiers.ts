export type PlanId = "free" | "solo" | "pro" | "sponsored" | "custom";

export interface PlanLimits {
  /** Max requests per month (0 = unlimited) */
  requestsPerMonth: number;
  /** Max CPU milliseconds per request (0 = unlimited) */
  cpuMsPerRequest: number;
  /** Max sub-requests per invocation (0 = unlimited) */
  subRequestsPerInvocation: number;
  /** Max deploys per day (0 = unlimited) */
  deploysPerDay: number;
  /** Max D1 storage in bytes (0 = unlimited) */
  d1StorageBytes: number;
  /** Max R2 storage in bytes (0 = unlimited) */
  r2StorageBytes: number;
  /** Max KV storage in bytes (0 = unlimited) */
  kvStorageBytes: number;
}

const GB = 1024 * 1024 * 1024;

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: {
    requestsPerMonth: 3_000_000,
    cpuMsPerRequest: 10,
    subRequestsPerInvocation: 50,
    deploysPerDay: 100,
    d1StorageBytes: 1 * GB,
    r2StorageBytes: 5 * GB,
    kvStorageBytes: 1 * GB,
  },
  solo: {
    requestsPerMonth: 10_000_000,
    cpuMsPerRequest: 30,
    subRequestsPerInvocation: 50,
    deploysPerDay: 500,
    d1StorageBytes: 5 * GB,
    r2StorageBytes: 25 * GB,
    kvStorageBytes: 5 * GB,
  },
  pro: {
    requestsPerMonth: 100_000_000,
    cpuMsPerRequest: 50,
    subRequestsPerInvocation: 1000,
    deploysPerDay: 3000,
    d1StorageBytes: 10 * GB,
    r2StorageBytes: 100 * GB,
    kvStorageBytes: 25 * GB,
  },
  sponsored: {
    requestsPerMonth: 0,
    cpuMsPerRequest: 50,
    subRequestsPerInvocation: 1000,
    deploysPerDay: 0,
    d1StorageBytes: 0,
    r2StorageBytes: 0,
    kvStorageBytes: 0,
  },
  custom: {
    requestsPerMonth: 0,
    cpuMsPerRequest: 0,
    subRequestsPerInvocation: 0,
    deploysPerDay: 0,
    d1StorageBytes: 0,
    r2StorageBytes: 0,
    kvStorageBytes: 0,
  },
};

/** Returns plan limits, defaulting to free tier for unknown plans. */
export function getPlanLimits(plan: string): PlanLimits {
  return PLAN_LIMITS[plan as PlanId] ?? PLAN_LIMITS.free;
}

/** Checks if current usage is within the limit. 0 = unlimited. */
export function isWithinLimit(limit: number, current: number): boolean {
  return limit === 0 || current < limit;
}
