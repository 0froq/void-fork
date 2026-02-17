import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import { docs } from "./docs.js";
import { searchDocs } from "./search.js";

function createServer(): McpServer {
  const server = new McpServer({ name: "vite-cloud-docs", version: "1.0.0" });

  server.registerTool(
    "list_pages",
    {
      description: "List all Vite Cloud documentation pages with their slugs and titles",
    },
    async () => {
      const list = docs.map((p) => `${p.slug} — ${p.title}`).join("\n");
      return { content: [{ type: "text" as const, text: list }] };
    },
  );

  server.registerTool(
    "get_page",
    {
      description: "Get the full content of a Vite Cloud documentation page by slug",
      inputSchema: { slug: z.string().describe("Page slug, e.g. 'routing' or 'quickstart'") },
    },
    async ({ slug }) => {
      const page = docs.find((p) => p.slug === slug);
      if (!page) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Page not found: ${slug}\n\nAvailable slugs: ${docs.map((p) => p.slug).join(", ")}`,
            },
          ],
        };
      }
      return { content: [{ type: "text" as const, text: `# ${page.title}\n\n${page.content}` }] };
    },
  );

  server.registerTool(
    "search_docs",
    {
      description:
        "Search Vite Cloud documentation by keyword query. Returns top 5 matching pages with snippets.",
      inputSchema: {
        query: z.string().describe("Search query, e.g. 'file routing' or 'database migrations'"),
      },
    },
    async ({ query }) => {
      const results = searchDocs(docs, query);
      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: "No results found." }] };
      }
      const text = results
        .map((r) => `**${r.title}** (${r.slug}, score: ${r.score})\n${r.snippet}`)
        .join("\n\n---\n\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );

  return server;
}

export default {
  fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    const server = createServer();
    const handler = createMcpHandler(server);
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler;
