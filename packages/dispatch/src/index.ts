import type { Env } from "./env";
import { extractSlug } from "./hostname";
import { serveStaticAsset, serveStaticAssetWithFallback, serveSSGAsset } from "./static";

interface RoutingEntry {
  workerName?: string;
  projectId: string;
  ssr?: boolean;
  mode?: "spa" | "ssg";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const slug = extractSlug(url.hostname);

    if (!slug) {
      return new Response("Not Found", { status: 404 });
    }

    // Look up routing info from KV
    const routingRaw = await env.ROUTING.get(slug);
    if (!routingRaw) {
      return new Response("Project not found", { status: 404 });
    }

    const routing: RoutingEntry = JSON.parse(routingRaw);

    // Static-only deploys (no worker)
    if (!routing.workerName) {
      if (routing.mode === "ssg") {
        return serveSSGAsset(env, routing.projectId, url.pathname);
      }
      return serveStaticAssetWithFallback(env, routing.projectId, url.pathname);
    }

    // API routes → dispatch to user worker
    if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
      const worker = env.DISPATCH.get(routing.workerName);
      return worker.fetch(request);
    }

    // Everything else → static assets first.
    // If SSR is enabled and static misses, dispatch to user worker for render().
    if (routing.ssr) {
      const staticResponse = await serveStaticAsset(env, routing.projectId, url.pathname, {
        spaFallback: false,
      });
      if (staticResponse) return staticResponse;
      const worker = env.DISPATCH.get(routing.workerName);
      return worker.fetch(request);
    }

    return serveStaticAssetWithFallback(env, routing.projectId, url.pathname);
  },
} satisfies ExportedHandler<Env>;
