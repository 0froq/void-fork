import { describe, it, expect } from "vitest";
import { isEmailAllowed } from "../../src/routes/auth";

describe("isEmailAllowed", () => {
  it("matches exact email (case-insensitive)", () => {
    expect(isEmailAllowed("alice@example.com", "Alice@Example.com")).toBe(true);
  });

  it("matches domain with @ prefix (case-insensitive)", () => {
    expect(isEmailAllowed("alice@voidzero.dev", "@VoidZero.Dev")).toBe(true);
  });

  it("rejects email not in allowlist", () => {
    expect(isEmailAllowed("alice@gmail.com", "@voidzero.dev")).toBe(false);
  });

  it("returns false for null email", () => {
    expect(isEmailAllowed(null, "@voidzero.dev")).toBe(false);
  });

  it("handles multiple comma-separated entries", () => {
    const allowlist = "@voidzero.dev, bob@gmail.com";
    expect(isEmailAllowed("alice@voidzero.dev", allowlist)).toBe(true);
    expect(isEmailAllowed("bob@gmail.com", allowlist)).toBe(true);
    expect(isEmailAllowed("eve@gmail.com", allowlist)).toBe(false);
  });

  it("trims whitespace around entries", () => {
    expect(isEmailAllowed("alice@voidzero.dev", "  @voidzero.dev  ")).toBe(true);
  });

  it("ignores empty entries from extra commas", () => {
    expect(isEmailAllowed("alice@voidzero.dev", ",@voidzero.dev,,")).toBe(true);
  });
});
