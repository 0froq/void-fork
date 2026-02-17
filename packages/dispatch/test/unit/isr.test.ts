import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  isrR2Key,
  isStale,
  resolveRevalidateTtl,
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
  it("sets x-isr-cache: HIT for fresh entry", () => {
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
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("sets x-isr-cache: STALE for stale entry", () => {
    const entry: IsrCacheEntry = {
      body: new ReadableStream(),
      status: 200,
      headers: {},
      createdAt: Date.now() - 120000,
      ttl: 60,
    };
    const response = isrCacheResponse(entry, true);
    expect(response.headers.get("x-isr-cache")).toBe("STALE");
  });
});
