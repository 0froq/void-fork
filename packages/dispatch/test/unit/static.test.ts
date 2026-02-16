import { describe, expect, it } from "vitest";
import { serveStaticAsset, serveStaticAssetWithFallback } from "../../src/static";
import type { Env } from "../../src/env";

function createObject(body: string, contentType = "text/plain"): R2ObjectBody {
  return {
    body,
    httpMetadata: { contentType },
    httpEtag: `"mock-etag"`,
  } as unknown as R2ObjectBody;
}

function createEnv(objects: Record<string, R2ObjectBody>): Env {
  return {
    ASSETS: {
      get: async (key: string) => objects[key] ?? null,
    },
  } as unknown as Env;
}

describe("serveStaticAsset", () => {
  it("serves static files when present", async () => {
    const env = createEnv({
      "proj/current/assets/app-abc12345.js": createObject(
        "console.log('ok')",
        "application/javascript",
      ),
    });

    const response = await serveStaticAsset(env, "proj", "/assets/app-abc12345.js", {
      spaFallback: false,
    });

    expect(response).not.toBeNull();
    expect(response!.headers.get("Content-Type")).toBe("application/javascript");
    expect(response!.headers.get("Cache-Control")).toContain("immutable");
  });

  it("returns null on miss when spa fallback is disabled", async () => {
    const env = createEnv({});
    const response = await serveStaticAsset(env, "proj", "/dashboard", { spaFallback: false });
    expect(response).toBeNull();
  });

  it("serves prerendered nested index html when spa fallback is disabled", async () => {
    const env = createEnv({
      "proj/current/about/index.html": createObject("<h1>about</h1>", "text/html; charset=utf-8"),
    });

    const response = await serveStaticAsset(env, "proj", "/about", { spaFallback: false });
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(response!.headers.get("Cache-Control")).toBe(
      "public, s-maxage=60, max-age=0, must-revalidate",
    );
    expect(await response!.text()).toBe("<h1>about</h1>");
  });

  it("includes ETag from R2 object", async () => {
    const env = createEnv({
      "proj/current/index.html": createObject("<h1>hi</h1>", "text/html"),
    });

    const response = await serveStaticAsset(env, "proj", "/index.html");
    expect(response).not.toBeNull();
    expect(response!.headers.get("ETag")).toBe(`"mock-etag"`);
  });
});

describe("serveStaticAssetWithFallback", () => {
  it("falls back to index.html for non-file paths", async () => {
    const env = createEnv({
      "proj/current/index.html": createObject("<h1>index</h1>", "text/html; charset=utf-8"),
    });

    const response = await serveStaticAssetWithFallback(env, "proj", "/dashboard");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>index</h1>");
  });
});
