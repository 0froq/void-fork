import { extendConfig } from "@voidzero-dev/vitepress-theme/config";
import { defineConfig } from "vitepress";

export default extendConfig(
  defineConfig({
    title: "Vite Cloud",
    description: "Fullstack Vite plugin for Cloudflare Workers",
    cleanUrls: true,

    themeConfig: {
      sidebar: {
        "/docs/": [
          {
            text: "Getting Started",
            items: [
              { text: "Introduction", link: "/docs/" },
              { text: "Quickstart", link: "/docs/quickstart" },
            ],
          },
          {
            text: "Core Concepts",
            items: [
              { text: "App Types", link: "/docs/app-types" },
              { text: "Type Safety", link: "/docs/type-safety" },
              { text: "Deployment", link: "/docs/deployment" },
            ],
          },
          {
            text: "Features",
            items: [
              { text: "File System Routing", link: "/docs/routing" },
              { text: "Typed Fetch", link: "/docs/typed-fetch" },
              { text: "Database", link: "/docs/db" },
              { text: "Key-Value Storage", link: "/docs/kv" },
              { text: "Object Storage", link: "/docs/storage" },
              { text: "Authentication", link: "/docs/auth" },
              { text: "SSR", link: "/docs/ssr" },
              { text: "SSG", link: "/docs/ssg" },
              { text: "Jobs", link: "/docs/jobs" },
              { text: "Caching and Headers", link: "/docs/cache" },
            ],
          },
          {
            text: "Integrations",
            items: [
              { text: "Hono", link: "/docs/hono" },
              { text: "Cloudflare", link: "/docs/cloudflare" },
            ],
          },
          {
            text: "Reference",
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
