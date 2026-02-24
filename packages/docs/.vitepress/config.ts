import { extendConfig } from "@voidzero-dev/vitepress-theme/config";
import { defineConfig } from "vitepress";
import { groupIconMdPlugin, groupIconVitePlugin } from "vitepress-plugin-group-icons";

export default extendConfig(
  defineConfig({
    title: "Void",
    description: "Fullstack Vite plugin for Cloudflare Workers",
    cleanUrls: true,

    markdown: {
      config(md) {
        md.use(groupIconMdPlugin);
      },
    },

    vite: {
      plugins: [groupIconVitePlugin()],
    },

    themeConfig: {
      search: {
        provider: "local",
      },

      nav: [
        { text: "Docs", link: "/", activeMatch: "/" },
        {
          text: "Reference",
          items: [
            { text: "Configuration", link: "/config" },
            { text: "API", link: "/api" },
            { text: "CLI", link: "/cli" },
          ],
        },
        {
          text: "Resources",
          items: [
            { text: "Guides", link: "/guides/", activeMatch: "/guides/" },
            { text: "Templates", link: "/templates/", activeMatch: "/templates/" },
            { text: "Blog", link: "/blog/", activeMatch: "/blog/" },
            { text: "MCP Server", link: "/mcp" },
          ],
        },
        { text: "Pricing", link: "/pricing" },
      ],

      sidebar: {
        "/": [
          {
            text: "Getting Started",
            collapsed: false,
            items: [
              { text: "Introduction", link: "/" },
              { text: "Quickstart", link: "/quickstart" },
            ],
          },
          {
            text: "Core Concepts",
            collapsed: false,
            items: [
              { text: "App Types", link: "/app-types" },
              { text: "Type Safety", link: "/type-safety" },
              { text: "Deployment", link: "/deployment" },
            ],
          },
          {
            text: "Features",
            collapsed: false,
            items: [
              { text: "Server Routing", link: "/server-routing" },
              { text: "Pages Routing", link: "/pages-routing" },
              { text: "Islands", link: "/islands" },
              { text: "Typed Fetch", link: "/typed-fetch" },
              { text: "Database", link: "/db" },
              { text: "Key-Value Storage", link: "/kv" },
              { text: "Blob Storage", link: "/storage" },
              { text: "Authentication", link: "/auth" },
              { text: "Custom SSR", link: "/ssr" },
              { text: "Caching and Headers", link: "/cache" },
              { text: "Cron Jobs", link: "/jobs" },
              { text: "Queues", link: "/queues" },
              { text: "AI", link: "/ai" },
              { text: "Environment Variables", link: "/env-vars" },
            ],
          },
          {
            text: "Integrations",
            collapsed: false,
            items: [
              { text: "Hono", link: "/hono" },
              { text: "Cloudflare", link: "/cloudflare" },
              { text: "MCP", link: "/mcp" },
            ],
          },
          {
            text: "Reference",
            collapsed: false,
            items: [
              { text: "Configuration", link: "/config" },
              { text: "API", link: "/api" },
              { text: "CLI", link: "/cli" },
            ],
          },
        ],
      },
    },
  }),
);
