import { extendConfig } from "@voidzero-dev/vitepress-theme/config";
import { defineConfig } from "vitepress";
import { groupIconMdPlugin, groupIconVitePlugin } from "vitepress-plugin-group-icons";

const referenceLinks = {
  text: "Reference",
  collapsed: false,
  items: [
    { text: "Configuration", link: "/config" },
    { text: "API", link: "/api" },
    { text: "CLI", link: "/cli" },
  ],
};

const integrationLinks = {
  text: "Integrations",
  collapsed: false,
  items: [
    { text: "Coding Agents", link: "integrations/agents" },
    { text: "Hono", link: "integrations/hono" },
    { text: "Cloudflare", link: "integrations/cloudflare" },
    { text: "ORMs", link: "integrations/orms" },
    { text: "Auth Providers", link: "integrations/auth-providers" },
    { text: "Payment Processors", link: "integrations/payment-processors" },
  ],
};

const resourcesLinks = {
  text: "Resources",
  items: [
    { text: "Guides", link: "/guides/", activeMatch: "/guides/" },
    { text: "Templates", link: "/templates/", activeMatch: "/templates/" },
    { text: "Blog", link: "/blog/", activeMatch: "/blog/" },
    referenceLinks,
    integrationLinks,
  ],
};

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
        { text: "Platform", link: "https://void.cloud" },
        { text: "Framework", link: "/", activeMatch: "/" },
        resourcesLinks,
      ],

      socialLinks: [
        { icon: "x", link: "https://x.com/voidcloudhq" },
        { icon: "discord", link: "https://discord.gg/cC6TEVFKSx" },
        { icon: "github", link: "https://github.com/voidzero-dev/void" },
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
          referenceLinks,
          integrationLinks,
        ],
      },
    },
  }),
);
