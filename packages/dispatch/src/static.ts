import type { Env } from "./env";

/**
 * Serve a static asset from R2.
 *
 * - Hashed assets (containing a hash in filename) get immutable cache headers
 * - index.html gets no-cache
 * - Non-file paths fall back to index.html when `spaFallback` is enabled
 *
 * Returns null when no static asset is found.
 */
export async function serveStaticAsset(
  env: Env,
  projectId: string,
  pathname: string,
  options?: { spaFallback?: boolean },
): Promise<Response | null> {
  const spaFallback = options?.spaFallback ?? true;

  // Normalize pathname
  let assetPath = pathname.startsWith("/") ? pathname.slice(1) : pathname;

  // SPA fallback: if path doesn't look like a file, serve index.html
  if (spaFallback && !hasExtension(assetPath)) {
    assetPath = "index.html";
  }

  const r2Key = `${projectId}/current/${assetPath}`;
  const object = await env.ASSETS.get(r2Key);

  if (!object) {
    // SSG fallback: /foo -> /foo/index.html
    if (!hasExtension(assetPath) && assetPath !== "" && assetPath !== "index.html") {
      const nestedIndexPath = `${assetPath.replace(/\/+$/, "")}/index.html`;
      const nested = await env.ASSETS.get(`${projectId}/current/${nestedIndexPath}`);
      if (nested) return buildResponse(nested, nestedIndexPath);
    }

    // Try index.html as final fallback
    if (assetPath !== "index.html") {
      const fallback = await env.ASSETS.get(`${projectId}/current/index.html`);
      if (fallback) return buildResponse(fallback, "index.html");
    }
    return null;
  }

  return buildResponse(object, assetPath);
}

/**
 * Serve a static SSG asset from R2.
 *
 * Resolution order:
 * 1. Exact file path
 * 2. <path>/index.html (for clean URLs)
 * 3. 404.html with status 404
 * 4. Plain 404 response
 */
export async function serveSSGAsset(
  env: Env,
  projectId: string,
  pathname: string,
): Promise<Response> {
  let assetPath = pathname.startsWith("/") ? pathname.slice(1) : pathname;

  // Try exact path (e.g. /styles.css, /about.html)
  if (assetPath && hasExtension(assetPath)) {
    const object = await env.ASSETS.get(`${projectId}/current/${assetPath}`);
    if (object) return buildResponse(object, assetPath);
  }

  // For paths without extension: try <path>/index.html
  if (!hasExtension(assetPath)) {
    // Root path → index.html
    const indexPath = assetPath ? `${assetPath.replace(/\/+$/, "")}/index.html` : "index.html";
    const index = await env.ASSETS.get(`${projectId}/current/${indexPath}`);
    if (index) return buildResponse(index, indexPath);
  }

  // Fallback: serve 404.html with 404 status
  const notFoundPage = await env.ASSETS.get(`${projectId}/current/404.html`);
  if (notFoundPage) {
    return new Response(notFoundPage.body, {
      status: 404,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  }

  return new Response("Not Found", { status: 404 });
}

export async function serveStaticAssetWithFallback(
  env: Env,
  projectId: string,
  pathname: string,
): Promise<Response> {
  const response = await serveStaticAsset(env, projectId, pathname, { spaFallback: true });
  return response ?? new Response("Not Found", { status: 404 });
}

function buildResponse(object: R2ObjectBody, path: string): Response {
  const headers = new Headers();

  // Content type from R2 metadata or guess from extension
  const contentType = object.httpMetadata?.contentType ?? guessContentType(path);
  headers.set("Content-Type", contentType);

  // Cache control: hashed assets are immutable, everything else is revalidated
  if (isHashedAsset(path)) {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    headers.set("Cache-Control", "public, s-maxage=60, max-age=0, must-revalidate");
  }

  return new Response(object.body, { headers });
}

function hasExtension(path: string): boolean {
  const lastSegment = path.split("/").pop() ?? "";
  return lastSegment.includes(".");
}

function isHashedAsset(path: string): boolean {
  // Vite generates hashed filenames like: assets/index-abc123.js
  return /assets\/.*-[a-zA-Z0-9]{8,}\.\w+$/.test(path);
}

function guessContentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    html: "text/html; charset=utf-8",
    css: "text/css",
    js: "application/javascript",
    mjs: "application/javascript",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    txt: "text/plain",
  };
  return types[ext ?? ""] ?? "application/octet-stream";
}
