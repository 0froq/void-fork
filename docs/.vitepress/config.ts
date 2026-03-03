import { extendConfig } from "@voidzero-dev/vitepress-theme/config";
import { defineConfig } from "vitepress";
import { groupIconMdPlugin, groupIconVitePlugin } from "vitepress-plugin-group-icons";

const referenceLinks = {
  text: "Reference",
  collapsed: false,
  items: [
    { text: "Configuration", link: "/config" },
    { text: "Resource Inference", link: "/resource-inference" },
    { text: "API", link: "/api" },
    { text: "CLI", link: "/cli" },
  ],
};

const integrationLinks = {
  text: "Integrations",
  collapsed: false,
  items: [
    {
      text: "Meta Frameworks",
      collapsed: true,
      items: [
        { text: "Overview", link: "/integrations/frameworks/overview" },
        { text: "TanStack Start", link: "/integrations/frameworks/tanstack-start" },
        { text: "React Router", link: "/integrations/frameworks/react-router" },
        { text: "Astro", link: "/integrations/frameworks/astro" },
        { text: "SvelteKit", link: "/integrations/frameworks/sveltekit" },
        { text: "Nuxt", link: "/integrations/frameworks/nuxt" },
        { text: "Vinext", link: "/integrations/frameworks/vinext" },
      ],
    },
    { text: "Coding Agents", link: "integrations/agents" },
    { text: "Hono", link: "integrations/hono" },
    { text: "Cloudflare", link: "integrations/cloudflare" },
    { text: "Node.js / Bun / Deno", link: "integrations/nodejs-bun-deno" },
    { text: "ORMs and External Databases", link: "integrations/orms-and-external-dbs" },
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
  ],
};

export default extendConfig(
  defineConfig({
    title: "Void",
    description: "Fullstack Vite plugin for Cloudflare Workers",
    cleanUrls: true,

    // ./index.server imports in code blocks are false positives
    ignoreDeadLinks: [/\/index$/],

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
        { text: "SDK", link: "/", activeMatch: "/" },
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
            text: "Routing & Rendering",
            collapsed: false,
            items: [
              { text: "Server Routing", link: "/server-routing" },
              {
                text: "Pages Routing",
                collapsed: true,
                items: [
                  { text: "Overview", link: "/pages-routing/overview" },
                  { text: "Loaders & Actions", link: "/pages-routing/loaders-actions" },
                  { text: "Layouts & Shared Data", link: "/pages-routing/layouts" },
                  { text: "Forms", link: "/pages-routing/forms" },
                  { text: "Deferred Props", link: "/pages-routing/deferred-props" },
                  { text: "View Transitions", link: "/pages-routing/view-transitions" },
                  { text: "Head Management", link: "/pages-routing/head" },
                  { text: "Islands", link: "/islands" },
                  { text: "Markdown", link: "/pages-routing/markdown" },
                ],
              },
              { text: "Custom SSR", link: "/ssr" },
              { text: "SSG", link: "/ssg" },
            ],
          },
          {
            text: "Data",
            collapsed: false,
            items: [
              { text: "Type Safety", link: "/type-safety" },
              { text: "Database", link: "/database" },
              { text: "Typed Fetch", link: "/typed-fetch" },
              { text: "Key-Value Storage", link: "/kv" },
              { text: "Blob Storage", link: "/storage" },
            ],
          },
          {
            text: "Platform",
            collapsed: false,
            items: [
              { text: "Supported App Types", link: "/app-types" },
              { text: "Deployment", link: "/deployment" },
              {
                text: "Edge Routing",
                collapsed: true,
                items: [
                  { text: "Static Assets Caching", link: "/cache/static-assets" },
                  { text: "Revalidation (ISR)", link: "/cache/revalidation" },
                  { text: "Edge Prerendering", link: "/cache/prerendering" },
                  { text: "Custom Headers", link: "/headers" },
                  { text: "Redirects", link: "/redirects" },
                ],
              },
              { text: "AI", link: "/ai" },
              { text: "Authentication", link: "/auth" },
              { text: "Cron Jobs", link: "/jobs" },
              { text: "Queues", link: "/queues" },
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
