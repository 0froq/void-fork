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
            text: "Core",
            items: [
              { text: "App Types", link: "/docs/app-types" },
              { text: "Routing", link: "/docs/routing" },
              { text: "Configuration", link: "/docs/config" },
              { text: "Deployment", link: "/docs/deployment" },
            ],
          },
          {
            text: "Features",
            items: [
              { text: "Cloudflare", link: "/docs/cloudflare" },
              { text: "Type Safety", link: "/docs/type-safety" },
              { text: "SSR", link: "/docs/ssr" },
              { text: "SSG", link: "/docs/ssg" },
              { text: "Jobs", link: "/docs/jobs" },
              { text: "Caching and Headers", link: "/docs/cache" },
            ],
          },
          {
            text: "Reference",
            items: [
              { text: "API", link: "/docs/api" },
              { text: "CLI", link: "/docs/cli" },
            ],
          },
        ],
      },
    },
  }),
);
