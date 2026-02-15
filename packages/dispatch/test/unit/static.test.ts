import { describe, expect, it } from "vitest";
import { serveStaticAsset, serveStaticAssetWithFallback } from "../../src/static";
import type { Env } from "../../src/env";

function createObject(body: string, contentType = "text/plain"): R2ObjectBody {
  return {
    body,
    httpMetadata: { contentType },
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
