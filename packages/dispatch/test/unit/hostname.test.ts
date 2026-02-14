import { describe, it, expect } from "vitest";
import { extractSlug } from "../../src/hostname";

describe("extractSlug", () => {
  it("extracts slug from valid hostname", () => {
    expect(extractSlug("my-app.vitecloud.app")).toBe("my-app");
  });

  it("extracts single-word slug", () => {
    expect(extractSlug("hello.vitecloud.app")).toBe("hello");
  });

  it("extracts slug with numbers", () => {
    expect(extractSlug("app123.vitecloud.app")).toBe("app123");
  });

  it("extracts single-char slug", () => {
    expect(extractSlug("x.vitecloud.app")).toBe("x");
  });

  it("returns null for bare domain", () => {
    expect(extractSlug("vitecloud.app")).toBeNull();
  });

  it("returns null for nested subdomain", () => {
    expect(extractSlug("foo.bar.vitecloud.app")).toBeNull();
  });

  it("returns null for unrelated domain", () => {
    expect(extractSlug("example.com")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractSlug("")).toBeNull();
  });

  it("returns null for slug with leading dash", () => {
    expect(extractSlug("-bad.vitecloud.app")).toBeNull();
  });

  it("returns null for slug with trailing dash", () => {
    expect(extractSlug("bad-.vitecloud.app")).toBeNull();
  });

  it("returns null for slug with uppercase", () => {
    expect(extractSlug("MyApp.vitecloud.app")).toBeNull();
  });

  it("returns null for slug with underscores", () => {
    expect(extractSlug("my_app.vitecloud.app")).toBeNull();
  });
});
