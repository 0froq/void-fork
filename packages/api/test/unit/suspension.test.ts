import { describe, it, expect } from "vitest";
import { isAdminSuspended, REASON_REQUESTS_EXCEEDED } from "../../src/suspension";

describe("isAdminSuspended", () => {
  it("returns false for null (not suspended)", () => {
    expect(isAdminSuspended(null)).toBe(false);
  });

  it("returns false for usage-limit reason", () => {
    expect(isAdminSuspended(REASON_REQUESTS_EXCEEDED)).toBe(false);
  });

  it("returns true for admin_suspended", () => {
    expect(isAdminSuspended("admin_suspended")).toBe(true);
  });

  it("returns true for unknown suspension reason", () => {
    expect(isAdminSuspended("some_other_reason")).toBe(true);
  });
});
