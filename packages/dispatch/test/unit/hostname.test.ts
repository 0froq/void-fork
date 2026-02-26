import { describe, it, expect } from "vitest";
import { extractSlug } from "../../src/hostname";

describe("extractSlug", () => {
  it("extracts slug from valid hostname", () => {
    expect(extractSlug("my-app.voidcloud.dev")).toBe("my-app");
  });

  it("extracts single-word slug", () => {
    expect(extractSlug("hello.voidcloud.dev")).toBe("hello");
  });

  it("extracts slug with numbers", () => {
    expect(extractSlug("app123.voidcloud.dev")).toBe("app123");
  });

  it("extracts single-char slug", () => {
    expect(extractSlug("x.voidcloud.dev")).toBe("x");
  });

  it("returns null for bare domain", () => {
    expect(extractSlug("voidcloud.dev")).toBeNull();
  });

  it("returns null for nested subdomain", () => {
    expect(extractSlug("foo.bar.voidcloud.dev")).toBeNull();
  });

  it("returns null for unrelated domain", () => {
    expect(extractSlug("example.com")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractSlug("")).toBeNull();
  });

  it("returns null for slug with leading dash", () => {
    expect(extractSlug("-bad.voidcloud.dev")).toBeNull();
  });

  it("returns null for slug with trailing dash", () => {
    expect(extractSlug("bad-.voidcloud.dev")).toBeNull();
  });

  it("returns null for slug with uppercase", () => {
    expect(extractSlug("MyApp.voidcloud.dev")).toBeNull();
  });

  it("returns null for slug with underscores", () => {
    expect(extractSlug("my_app.voidcloud.dev")).toBeNull();
  });

  describe("custom baseHostname", () => {
    it("extracts slug from staging hostname", () => {
      expect(extractSlug("my-app.staging.voidcloud.dev", "staging.voidcloud.dev")).toBe("my-app");
    });

    it("returns null for production hostname when expecting staging", () => {
      expect(extractSlug("my-app.voidcloud.dev", "staging.voidcloud.dev")).toBeNull();
    });

    it("returns null for staging hostname when expecting production", () => {
      expect(extractSlug("my-app.staging.voidcloud.dev", "voidcloud.dev")).toBeNull();
    });

    it("returns null for bare staging domain", () => {
      expect(extractSlug("staging.voidcloud.dev", "staging.voidcloud.dev")).toBeNull();
    });

    it("rejects nested subdomains on staging", () => {
      expect(extractSlug("foo.bar.staging.voidcloud.dev", "staging.voidcloud.dev")).toBeNull();
    });

    it("uses default baseHostname when omitted", () => {
      expect(extractSlug("my-app.voidcloud.dev")).toBe("my-app");
    });
  });
});
