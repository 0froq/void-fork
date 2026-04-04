import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  isrCacheKey,
  isStale,
  resolveRevalidateTtl,
  resolvePathTtl,
  shouldBypassIsr,
  isrCacheResponse,
  isrEdgeCacheKeyJson,
  serializeHeaders,
  packIsrValue,
  unpackIsrValue,
  extractPageDataFromHtml,
  normalizePageDataForJsonCache,
  type IsrCacheEntry,
} from "../../src/isr";

describe("isrCacheKey", () => {
  it("maps root path to __index__", () => {
    expect(isrCacheKey("proj_1", "/")).toBe("proj_1/isr/__index__");
  });

  it("strips leading slash", () => {
    expect(isrCacheKey("proj_1", "/about")).toBe("proj_1/isr/about");
  });

  it("strips trailing slash", () => {
    expect(isrCacheKey("proj_1", "/about/")).toBe("proj_1/isr/about");
  });

  it("handles nested paths", () => {
    expect(isrCacheKey("proj_1", "/blog/hello-world")).toBe("proj_1/isr/blog/hello-world");
  });

  it("handles path without leading slash", () => {
    expect(isrCacheKey("proj_1", "about")).toBe("proj_1/isr/about");
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

  it("returns false for X-VoidPages header (uses JSON edge cache instead)", () => {
    const request = new Request("https://example.com", {
      headers: { "X-VoidPages": "true" },
    });
    expect(shouldBypassIsr(request)).toBe(false);
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

describe("isrEdgeCacheKeyJson", () => {
  it("appends ?__void=json suffix", () => {
    const request = new Request("https://app.void.app/about?q=1");
    const key = isrEdgeCacheKeyJson(request, "/about");
    expect(key.url).toBe("https://app.void.app/about?__void=json");
    expect(key.method).toBe("GET");
  });

  it("handles root path", () => {
    const request = new Request("https://app.void.app/");
    const key = isrEdgeCacheKeyJson(request, "/");
    expect(key.url).toBe("https://app.void.app/?__void=json");
  });
});

describe("serializeHeaders", () => {
  it("skips x-void-page-data header", () => {
    const response = new Response("ok", {
      headers: {
        "content-type": "text/html",
        "x-void-page-data": '{"component":"Index"}',
        "x-custom": "keep",
      },
    });
    const result = serializeHeaders(response);
    expect(result["content-type"]).toBe("text/html");
    expect(result["x-custom"]).toBe("keep");
    expect(result["x-void-page-data"]).toBeUndefined();
  });

  it("skips cache-control and x-isr-cache", () => {
    const response = new Response("ok", {
      headers: {
        "cache-control": "public",
        "x-isr-cache": "HIT",
        "content-type": "text/html",
      },
    });
    const result = serializeHeaders(response);
    expect(result["cache-control"]).toBeUndefined();
    expect(result["x-isr-cache"]).toBeUndefined();
    expect(result["content-type"]).toBe("text/html");
  });

  it("strips set-cookie to prevent cross-user session replay", () => {
    const response = new Response("ok", {
      headers: {
        "content-type": "text/html",
        "set-cookie": "session=abc123; Path=/; HttpOnly",
        "x-custom": "keep",
      },
    });
    const result = serializeHeaders(response);
    expect(result["set-cookie"]).toBeUndefined();
    expect(result["content-type"]).toBe("text/html");
    expect(result["x-custom"]).toBe("keep");
  });
});

describe("page data extraction", () => {
  it("extracts embedded page data from the JSON script tag", () => {
    const pageData = '{"component":"Index","props":{"title":"hello"}}';
    const html = `<html><body><script id="__VOID_PAGE_DATA__" type="application/json">${pageData}</script><div id="app"></div></body></html>`;
    expect(extractPageDataFromHtml(html)).toBe(pageData);
  });

  it("skips embedded payloads with deferred metadata", () => {
    const html =
      '<script id="__VOID_PAGE_DATA__" type="application/json">{"component":"Index","props":{},"deferred":["stats"],"deferredKeys":{"stats":"stats"}}</script>';
    expect(extractPageDataFromHtml(html)).toBeNull();
  });

  it("normalizes legacy header payloads and rejects deferred ones", () => {
    expect(normalizePageDataForJsonCache('{"component":"Index","props":{}}')).toBe(
      '{"component":"Index","props":{}}',
    );
    expect(
      normalizePageDataForJsonCache(
        '{"component":"Index","props":{},"deferred":["stats"],"deferredKeys":{"stats":"stats"}}',
      ),
    ).toBeNull();
  });
});

describe("packIsrValue / unpackIsrValue", () => {
  it("round-trips headers and body", () => {
    const headers = { "content-type": "text/html", etag: '"abc"' };
    const body = new TextEncoder().encode("<html>hello</html>").buffer as ArrayBuffer;
    const packed = packIsrValue(headers, body);
    const result = unpackIsrValue(packed);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(headers);
    expect(new TextDecoder().decode(result!.body)).toBe("<html>hello</html>");
  });

  it("handles empty body", () => {
    const headers = { "content-type": "text/html" };
    const body = new ArrayBuffer(0);
    const packed = packIsrValue(headers, body);
    const result = unpackIsrValue(packed);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(headers);
    expect(result!.body.byteLength).toBe(0);
  });

  it("handles empty headers", () => {
    const headers = {};
    const body = new TextEncoder().encode("hello").buffer as ArrayBuffer;
    const packed = packIsrValue(headers, body);
    const result = unpackIsrValue(packed);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual({});
    expect(new TextDecoder().decode(result!.body)).toBe("hello");
  });

  it("returns null for buffer too small", () => {
    expect(unpackIsrValue(new ArrayBuffer(2))).toBeNull();
  });

  it("returns null for truncated header", () => {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, 999, true); // claims 999 bytes of headers
    expect(unpackIsrValue(buf)).toBeNull();
  });
});
