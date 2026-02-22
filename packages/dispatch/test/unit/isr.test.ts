import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  isrR2Key,
  isStale,
  resolveRevalidateTtl,
  resolvePathTtl,
  shouldBypassIsr,
  isrCacheResponse,
  type IsrCacheEntry,
} from "../../src/isr";

describe("isrR2Key", () => {
  it("maps root path to __index__", () => {
    expect(isrR2Key("proj_1", "/")).toBe("proj_1/isr/__index__");
  });

  it("strips leading slash", () => {
    expect(isrR2Key("proj_1", "/about")).toBe("proj_1/isr/about");
  });

  it("strips trailing slash", () => {
    expect(isrR2Key("proj_1", "/about/")).toBe("proj_1/isr/about");
  });

  it("handles nested paths", () => {
    expect(isrR2Key("proj_1", "/blog/hello-world")).toBe("proj_1/isr/blog/hello-world");
  });

  it("handles path without leading slash", () => {
    expect(isrR2Key("proj_1", "about")).toBe("proj_1/isr/about");
  });
});

describe("isStale", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false when entry is fresh", () => {
    vi.setSystemTime(1000000);
    const entry: IsrCacheEntry = {
      body: new ReadableStream(),
      status: 200,
      headers: {},
      createdAt: 1000000,
      ttl: 60,
    };
    expect(isStale(entry)).toBe(false);
  });

  it("returns true when entry is expired", () => {
    vi.setSystemTime(1000000 + 61 * 1000);
    const entry: IsrCacheEntry = {
      body: new ReadableStream(),
      status: 200,
      headers: {},
      createdAt: 1000000,
      ttl: 60,
    };
    expect(isStale(entry)).toBe(true);
  });

  it("returns false at exact TTL boundary", () => {
    vi.setSystemTime(1000000 + 60 * 1000);
    const entry: IsrCacheEntry = {
      body: new ReadableStream(),
      status: 200,
      headers: {},
      createdAt: 1000000,
      ttl: 60,
    };
    expect(isStale(entry)).toBe(false);
  });
});

describe("resolveRevalidateTtl", () => {
  it("returns default when no header present", () => {
    const response = new Response("ok");
    expect(resolveRevalidateTtl(response, 60)).toBe(60);
  });

  it("returns header value when present", () => {
    const response = new Response("ok", {
      headers: { "x-revalidate": "120" },
    });
    expect(resolveRevalidateTtl(response, 60)).toBe(120);
  });

  it("returns 0 for opt-out header", () => {
    const response = new Response("ok", {
      headers: { "x-revalidate": "0" },
    });
    expect(resolveRevalidateTtl(response, 60)).toBe(0);
  });

  it("returns default for invalid header value", () => {
    const response = new Response("ok", {
      headers: { "x-revalidate": "abc" },
    });
    expect(resolveRevalidateTtl(response, 60)).toBe(60);
  });

  it("returns default for negative header value", () => {
    const response = new Response("ok", {
      headers: { "x-revalidate": "-5" },
    });
    expect(resolveRevalidateTtl(response, 60)).toBe(60);
  });
});

describe("resolvePathTtl", () => {
  it("returns 0 for undefined", () => {
    expect(resolvePathTtl(undefined, "/")).toBe(0);
  });

  it("returns the number for numeric revalidate", () => {
    expect(resolvePathTtl(60, "/anything")).toBe(60);
  });

  it("matches exact path in object", () => {
    expect(resolvePathTtl({ "/": 60, "*": 30 }, "/")).toBe(60);
  });

  it("matches glob pattern", () => {
    expect(resolvePathTtl({ "/docs/*": 120, "*": 30 }, "/docs/intro")).toBe(120);
  });

  it("returns 0 when no pattern matches", () => {
    expect(resolvePathTtl({ "/docs/*": 120 }, "/about")).toBe(0);
  });

  it("uses first-match-wins ordering", () => {
    expect(resolvePathTtl({ "/docs/*": 120, "*": 30 }, "/docs/intro")).toBe(120);
    expect(resolvePathTtl({ "*": 30, "/docs/*": 120 }, "/docs/intro")).toBe(30);
  });

  it("supports zero TTL for specific paths", () => {
    expect(resolvePathTtl({ "/user/*": 0, "*": 60 }, "/user/profile")).toBe(0);
  });
});

describe("shouldBypassIsr", () => {
  it("returns true when Cookie header is present", () => {
    const request = new Request("https://example.com", {
      headers: { Cookie: "session=abc" },
    });
    expect(shouldBypassIsr(request)).toBe(true);
  });

  it("returns true when Authorization header is present", () => {
    const request = new Request("https://example.com", {
      headers: { Authorization: "Bearer token" },
    });
    expect(shouldBypassIsr(request)).toBe(true);
  });

  it("returns false for plain GET request", () => {
    const request = new Request("https://example.com");
    expect(shouldBypassIsr(request)).toBe(false);
  });
});

describe("isrCacheResponse", () => {
  it("sets x-isr-cache: HIT with edge-cacheable headers for fresh entry", () => {
    const entry: IsrCacheEntry = {
      body: new ReadableStream(),
      status: 200,
      headers: { "Content-Type": "text/html" },
      createdAt: Date.now(),
      ttl: 60,
    };
    const response = isrCacheResponse(entry, false);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-isr-cache")).toBe("HIT");
    expect(response.headers.get("Content-Type")).toBe("text/html");
    const cc = response.headers.get("Cache-Control")!;
    expect(cc).toContain("public");
    expect(cc).toContain("s-maxage=");
    expect(cc).toContain("must-revalidate");
  });

  it("sets x-isr-cache: STALE with short edge TTL for stale entry", () => {
    const entry: IsrCacheEntry = {
      body: new ReadableStream(),
      status: 200,
      headers: {},
      createdAt: Date.now() - 120000,
      ttl: 60,
    };
    const response = isrCacheResponse(entry, true);
    expect(response.headers.get("x-isr-cache")).toBe("STALE");
    expect(response.headers.get("Cache-Control")).toBe(
      "public, s-maxage=10, max-age=0, must-revalidate",
    );
  });

  it("caps stale edge TTL at entry.ttl for short ISR windows", () => {
    const entry: IsrCacheEntry = {
      body: new ReadableStream(),
      status: 200,
      headers: {},
      createdAt: Date.now() - 10000,
      ttl: 5,
    };
    const response = isrCacheResponse(entry, true);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, s-maxage=5, max-age=0, must-revalidate",
    );
  });
});
