import { describe, it, expect } from "vitest";
import { parseHeaders } from "../../src/headers/parse";

describe("parseHeaders", () => {
  it("parses a single rule with one header", () => {
    const result = parseHeaders("/assets/*\n  Cache-Control: public, max-age=31536000, immutable");
    expect(result).toEqual([
      { pattern: "/assets/*", headers: [["Cache-Control", "public, max-age=31536000, immutable"]] },
    ]);
  });

  it("parses multiple rules", () => {
    const input = `/assets/*
  Cache-Control: public, max-age=31536000, immutable

/*.html
  Cache-Control: no-cache
`;
    const result = parseHeaders(input);
    expect(result).toEqual([
      { pattern: "/assets/*", headers: [["Cache-Control", "public, max-age=31536000, immutable"]] },
      { pattern: "/*.html", headers: [["Cache-Control", "no-cache"]] },
    ]);
  });

  it("parses multiple headers under one pattern", () => {
    const input = `/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
`;
    const result = parseHeaders(input);
    expect(result).toEqual([
      {
        pattern: "/*",
        headers: [
          ["X-Frame-Options", "DENY"],
          ["X-Content-Type-Options", "nosniff"],
        ],
      },
    ]);
  });

  it("ignores comment lines", () => {
    const input = `# This is a comment
/assets/*
  # Another comment
  Cache-Control: public, max-age=31536000
`;
    const result = parseHeaders(input);
    expect(result).toEqual([
      { pattern: "/assets/*", headers: [["Cache-Control", "public, max-age=31536000"]] },
    ]);
  });

  it("ignores blank lines", () => {
    const input = `

/assets/*

  Cache-Control: no-cache

`;
    const result = parseHeaders(input);
    expect(result).toEqual([{ pattern: "/assets/*", headers: [["Cache-Control", "no-cache"]] }]);
  });

  it("returns empty array for empty input", () => {
    expect(parseHeaders("")).toEqual([]);
  });

  it("returns empty array for only comments", () => {
    expect(parseHeaders("# just a comment\n# another")).toEqual([]);
  });

  it("handles header values with colons", () => {
    const input = `/api/*
  Link: <https://example.com>; rel="preconnect"
`;
    const result = parseHeaders(input);
    expect(result).toEqual([
      {
        pattern: "/api/*",
        headers: [["Link", `<https://example.com>; rel="preconnect"`]],
      },
    ]);
  });

  it("handles tab-indented headers", () => {
    const input = "/assets/*\n\tCache-Control: no-cache";
    const result = parseHeaders(input);
    expect(result).toEqual([{ pattern: "/assets/*", headers: [["Cache-Control", "no-cache"]] }]);
  });

  it("trims whitespace from header names and values", () => {
    const input = "/assets/*\n   Cache-Control :  public, max-age=0  ";
    const result = parseHeaders(input);
    expect(result).toEqual([
      { pattern: "/assets/*", headers: [["Cache-Control", "public, max-age=0"]] },
    ]);
  });

  it("skips indented lines without a colon", () => {
    const input = "/assets/*\n  not-a-header\n  Cache-Control: ok";
    const result = parseHeaders(input);
    expect(result).toEqual([{ pattern: "/assets/*", headers: [["Cache-Control", "ok"]] }]);
  });

  it("skips indented lines before any pattern", () => {
    const input = "  Orphan: value\n/assets/*\n  Cache-Control: ok";
    const result = parseHeaders(input);
    expect(result).toEqual([{ pattern: "/assets/*", headers: [["Cache-Control", "ok"]] }]);
  });
});
