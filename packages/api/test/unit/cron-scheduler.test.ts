import { describe, it, expect, vi } from "vitest";

// Mock cloudflare:workers since DurableObject base class isn't available in unit tests
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));

import { cfCronToUnix, cronMatchesMinute, getNextFireTime } from "../../src/cron-scheduler";

describe("cfCronToUnix", () => {
  it("converts single numeric DOW (CF 1=Sun → Unix 0=Sun)", () => {
    expect(cfCronToUnix("0 12 * * 1")).toBe("0 12 * * 0");
  });

  it("converts CF 2=Mon → Unix 1=Mon", () => {
    expect(cfCronToUnix("0 12 * * 2")).toBe("0 12 * * 1");
  });

  it("converts CF 7=Sat → Unix 6=Sat", () => {
    expect(cfCronToUnix("0 0 * * 7")).toBe("0 0 * * 6");
  });

  it("converts ranges: CF 2-6 → Unix 1-5", () => {
    expect(cfCronToUnix("0 9 * * 2-6")).toBe("0 9 * * 1-5");
  });

  it("converts lists: CF 1,4,7 → Unix 0,3,6", () => {
    expect(cfCronToUnix("0 0 * * 1,4,7")).toBe("0 0 * * 0,3,6");
  });

  it("converts ranges with steps: CF 2-6/2 → Unix 1-5/2", () => {
    expect(cfCronToUnix("30 8 * * 2-6/2")).toBe("30 8 * * 1-5/2");
  });

  it("preserves * and */N", () => {
    expect(cfCronToUnix("* * * * *")).toBe("* * * * *");
    expect(cfCronToUnix("0 0 * * */2")).toBe("0 0 * * */2");
  });

  it("preserves abbreviations (MON, FRI)", () => {
    expect(cfCronToUnix("0 12 * * MON")).toBe("0 12 * * MON");
    expect(cfCronToUnix("0 9 * * MON-FRI")).toBe("0 9 * * MON-FRI");
  });

  it("passes through non-5-field expressions unchanged", () => {
    expect(cfCronToUnix("not-a-cron")).toBe("not-a-cron");
  });
});

describe("cronMatchesMinute", () => {
  it("matches every-minute cron at any time", () => {
    const now = new Date("2026-03-02T10:30:00Z").getTime();
    expect(cronMatchesMinute("* * * * *", now)).toBe(true);
  });

  it("matches hourly cron at the correct minute", () => {
    const atTop = new Date("2026-03-02T10:00:00Z").getTime();
    expect(cronMatchesMinute("0 * * * *", atTop)).toBe(true);

    const atHalf = new Date("2026-03-02T10:30:00Z").getTime();
    expect(cronMatchesMinute("0 * * * *", atHalf)).toBe(false);
  });

  it("matches within the same minute even with seconds offset", () => {
    const now = new Date("2026-03-02T10:00:45Z").getTime();
    expect(cronMatchesMinute("0 * * * *", now)).toBe(true);
  });

  it("does not match hourly cron at wrong minute", () => {
    const now = new Date("2026-03-02T10:15:00Z").getTime();
    expect(cronMatchesMinute("0 * * * *", now)).toBe(false);
  });

  it("matches day-of-week using CF convention (2=Mon)", () => {
    // 2026-03-02 is a Monday
    const monday = new Date("2026-03-02T12:00:00Z").getTime();
    expect(cronMatchesMinute("0 12 * * 2", monday)).toBe(true); // CF 2=Mon

    // Should not match on Tuesday
    const tuesday = new Date("2026-03-03T12:00:00Z").getTime();
    expect(cronMatchesMinute("0 12 * * 2", tuesday)).toBe(false);
  });

  it("matches Sunday as CF 1", () => {
    // 2026-03-01 is a Sunday
    const sunday = new Date("2026-03-01T12:00:00Z").getTime();
    expect(cronMatchesMinute("0 12 * * 1", sunday)).toBe(true); // CF 1=Sun
    expect(cronMatchesMinute("0 12 * * 2", sunday)).toBe(false); // CF 2=Mon
  });

  it("matches with abbreviations (unambiguous)", () => {
    const monday = new Date("2026-03-02T12:00:00Z").getTime();
    expect(cronMatchesMinute("0 12 * * MON", monday)).toBe(true);
  });

  it("returns false for invalid cron expression", () => {
    const now = Date.now();
    expect(cronMatchesMinute("not-a-cron", now)).toBe(false);
  });
});

describe("getNextFireTime", () => {
  it("returns next minute for every-minute cron", () => {
    const now = new Date("2026-03-02T10:30:00Z").getTime();
    const next = getNextFireTime([{ cron: "* * * * *" }], now);
    expect(next).toBe(new Date("2026-03-02T10:31:00Z").getTime());
  });

  it("returns next hour for hourly cron", () => {
    const now = new Date("2026-03-02T10:00:01Z").getTime();
    const next = getNextFireTime([{ cron: "0 * * * *" }], now);
    expect(next).toBe(new Date("2026-03-02T11:00:00Z").getTime());
  });

  it("returns earliest across multiple schedules", () => {
    const now = new Date("2026-03-02T10:00:01Z").getTime();
    const next = getNextFireTime([{ cron: "0 * * * *" }, { cron: "* * * * *" }], now);
    expect(next).toBe(new Date("2026-03-02T10:01:00Z").getTime());
  });

  it("returns null for empty schedules", () => {
    expect(getNextFireTime([], Date.now())).toBe(null);
  });

  it("skips invalid cron expressions and returns valid ones", () => {
    const now = new Date("2026-03-02T10:30:00Z").getTime();
    const next = getNextFireTime([{ cron: "invalid" }, { cron: "* * * * *" }], now);
    expect(next).toBe(new Date("2026-03-02T10:31:00Z").getTime());
  });

  it("returns null when all expressions are invalid", () => {
    expect(getNextFireTime([{ cron: "bad" }, { cron: "worse" }], Date.now())).toBe(null);
  });
});
