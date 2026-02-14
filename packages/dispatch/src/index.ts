import type { Env } from "./env";
import { extractSlug } from "./hostname";
import { serveStaticAsset } from "./static";

interface RoutingEntry {
  workerName: string;
  projectId: string;
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

    // API routes → dispatch to user worker
    if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
      const worker = env.DISPATCH.get(routing.workerName);
      return worker.fetch(request);
    }

    // Everything else → serve static assets from R2
    return serveStaticAsset(request, env, routing.projectId, url.pathname);
  },
} satisfies ExportedHandler<Env>;
