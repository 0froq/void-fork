import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Vite Cloud",
  description: "Fullstack Vite plugin for Cloudflare Workers",
  cleanUrls: true,

  themeConfig: {
    sidebar: {
      "/docs/": [
        {
          text: "Getting Started",
          items: [
            { text: "Introduction", link: "/docs/intro" },
            { text: "Quickstart", link: "/docs/quickstart" },
          ],
        },
        {
          text: "Core",
          items: [
            { text: "Routing", link: "/docs/routing" },
            { text: "Configuration", link: "/docs/config" },
            { text: "Cloudflare", link: "/docs/cloudflare" },
          ],
        },
        {
          text: "Features",
          items: [
            { text: "SSR", link: "/docs/ssr" },
            { text: "SSG", link: "/docs/ssg" },
            { text: "Jobs", link: "/docs/jobs" },
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
});
