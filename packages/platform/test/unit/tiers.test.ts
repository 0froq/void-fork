import { describe, it, expect } from "vitest";
import { PLAN_LIMITS, getPlanLimits, isWithinLimit, type PlanId } from "../../src/tiers";

describe("PLAN_LIMITS", () => {
  it("defines all five tiers", () => {
    const tiers: PlanId[] = ["free", "solo", "pro", "sponsored", "custom"];
    for (const tier of tiers) {
      expect(PLAN_LIMITS[tier]).toBeDefined();
    }
  });

  it("free tier has expected limits", () => {
    const free = PLAN_LIMITS.free;
    expect(free.requestsPerMonth).toBe(3_000_000);
    expect(free.cpuMsPerRequest).toBe(10);
    expect(free.subRequestsPerInvocation).toBe(50);
    expect(free.deploysPerDay).toBe(100);
    expect(free.d1StorageBytes).toBe(1024 * 1024 * 1024);
    expect(free.r2StorageBytes).toBe(5 * 1024 * 1024 * 1024);
    expect(free.kvStorageBytes).toBe(1024 * 1024 * 1024);
  });

  it("custom tier has all limits set to 0 (unlimited)", () => {
    const custom = PLAN_LIMITS.custom;
    for (const value of Object.values(custom)) {
      expect(value).toBe(0);
    }
  });

  it("sponsored tier has unlimited requests, deploys, and storage", () => {
    const sponsored = PLAN_LIMITS.sponsored;
    expect(sponsored.requestsPerMonth).toBe(0);
    expect(sponsored.deploysPerDay).toBe(0);
    expect(sponsored.d1StorageBytes).toBe(0);
    expect(sponsored.r2StorageBytes).toBe(0);
    expect(sponsored.kvStorageBytes).toBe(0);
  });

  it("paid tiers have higher limits than free", () => {
    expect(PLAN_LIMITS.solo.requestsPerMonth).toBeGreaterThan(PLAN_LIMITS.free.requestsPerMonth);
    expect(PLAN_LIMITS.pro.requestsPerMonth).toBeGreaterThan(PLAN_LIMITS.solo.requestsPerMonth);
    expect(PLAN_LIMITS.solo.cpuMsPerRequest).toBeGreaterThan(PLAN_LIMITS.free.cpuMsPerRequest);
    expect(PLAN_LIMITS.pro.deploysPerDay).toBeGreaterThan(PLAN_LIMITS.solo.deploysPerDay);
  });
});

describe("getPlanLimits", () => {
  it("returns correct limits for known plans", () => {
    expect(getPlanLimits("free")).toBe(PLAN_LIMITS.free);
    expect(getPlanLimits("solo")).toBe(PLAN_LIMITS.solo);
    expect(getPlanLimits("pro")).toBe(PLAN_LIMITS.pro);
    expect(getPlanLimits("sponsored")).toBe(PLAN_LIMITS.sponsored);
    expect(getPlanLimits("custom")).toBe(PLAN_LIMITS.custom);
  });

  it("returns free tier limits for unknown plans", () => {
    expect(getPlanLimits("unknown")).toBe(PLAN_LIMITS.free);
    expect(getPlanLimits("")).toBe(PLAN_LIMITS.free);
  });
});

describe("isWithinLimit", () => {
  it("returns true when limit is 0 (unlimited)", () => {
    expect(isWithinLimit(0, 999_999_999)).toBe(true);
  });

  it("returns true when current is below limit", () => {
    expect(isWithinLimit(100, 50)).toBe(true);
  });

  it("returns false when current meets or exceeds limit", () => {
    expect(isWithinLimit(100, 100)).toBe(false);
    expect(isWithinLimit(100, 200)).toBe(false);
  });

  it("returns true when current is 0", () => {
    expect(isWithinLimit(100, 0)).toBe(true);
  });
});
