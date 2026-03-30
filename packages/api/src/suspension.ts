export const REASON_REQUESTS_EXCEEDED = "requests_exceeded";

const USAGE_LIMIT_REASONS = new Set([REASON_REQUESTS_EXCEEDED]);

/**
 * Returns true when the user is suspended by an admin action (not by
 * automatic usage-limit enforcement). Usage-suspended users must retain
 * dashboard and API access so they can inspect usage and upgrade.
 */
export function isAdminSuspended(suspendedReason: string | null): boolean {
  return suspendedReason !== null && !USAGE_LIMIT_REASONS.has(suspendedReason);
}
