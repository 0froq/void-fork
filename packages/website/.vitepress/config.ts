import { extendConfig } from "@voidzero-dev/vitepress-theme/config";
import { defineConfig } from "vitepress";
import { groupIconMdPlugin, groupIconVitePlugin } from "vitepress-plugin-group-icons";

export default extendConfig(
  defineConfig({
    title: "Vite Cloud",
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
        { text: "Docs", link: "/docs/", activeMatch: "/docs/" },
        {
          text: "Reference",
          items: [
            { text: "Configuration", link: "/docs/config" },
            { text: "API", link: "/docs/api" },
            { text: "CLI", link: "/docs/cli" },
          ],
        },
        {
          text: "Resources",
          items: [
            { text: "Guides", link: "/guides/", activeMatch: "/guides/" },
            { text: "Templates", link: "/templates/", activeMatch: "/templates/" },
            { text: "Blog", link: "/blog/", activeMatch: "/blog/" },
            { text: "MCP Server", link: "/docs/mcp" },
          ],
        },
        { text: "Pricing", link: "/pricing" },
      ],

      sidebar: {
        "/docs/": [
          {
            text: "Getting Started",
            collapsed: false,
            items: [
              { text: "Introduction", link: "/docs/" },
              { text: "Quickstart", link: "/docs/quickstart" },
            ],
          },
          {
            text: "Core Concepts",
            collapsed: false,
            items: [
              { text: "App Types", link: "/docs/app-types" },
              { text: "Type Safety", link: "/docs/type-safety" },
              { text: "Deployment", link: "/docs/deployment" },
            ],
          },
          {
            text: "Features",
            collapsed: false,
            items: [
              { text: "File System Routing", link: "/docs/routing" },
              { text: "Typed Fetch", link: "/docs/typed-fetch" },
              { text: "Database", link: "/docs/db" },
              { text: "Key-Value Storage", link: "/docs/kv" },
              { text: "Blob Storage", link: "/docs/storage" },
              { text: "Authentication", link: "/docs/auth" },
              { text: "Server-side Rendering (SSR)", link: "/docs/ssr" },
              { text: "Edge Caching", link: "/docs/edge-caching" },
              { text: "Cron Jobs", link: "/docs/jobs" },
              { text: "Queues", link: "/docs/queues" },
              { text: "Environment Variables", link: "/docs/env-vars" },
              { text: "Caching and Headers", link: "/docs/cache" },
            ],
          },
          {
            text: "Integrations",
            collapsed: false,
            items: [
              { text: "Hono", link: "/docs/hono" },
              { text: "Cloudflare", link: "/docs/cloudflare" },
              { text: "MCP", link: "/docs/mcp" },
            ],
          },
          {
            text: "Reference",
            collapsed: false,
            items: [
              { text: "Configuration", link: "/docs/config" },
              { text: "API", link: "/docs/api" },
              { text: "CLI", link: "/docs/cli" },
            ],
          },
        ],
      },
    },
  }),
);
