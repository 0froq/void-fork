import { extendConfig } from "@voidzero-dev/vitepress-theme/config";
import { defineConfig } from "vitepress";
import { groupIconMdPlugin, groupIconVitePlugin } from "vitepress-plugin-group-icons";

const referenceLinks = {
  text: "Reference",
  activeMatch: "/reference/",
  items: [
    { text: "Project Structure", link: "/reference/structure" },
    { text: "Configuration", link: "/reference/config" },
    { text: "Resource Inference", link: "/reference/resource-inference" },
    {
      text: "API",
      link: "/reference/api",
      collapsed: false,
      items: [
        { text: "Plugin", link: "/reference/api#plugin" },
        { text: "Handlers", link: "/reference/api#handlers" },
        { text: "Auth", link: "/reference/api#auth" },
        { text: "Fetch Client", link: "/reference/api#fetch-client" },
        { text: "Database", link: "/reference/api#database" },
        { text: "Types", link: "/reference/api#types" },
        { text: "Environment Types", link: "/reference/api#environment-types" },
        { text: "Framework Adaptors", link: "/reference/api#framework-adaptors" },
        { text: "Subpath Exports", link: "/reference/api#subpath-exports" },
      ],
    },
    {
      text: "CLI",
      link: "/reference/cli",
      collapsed: false,
      items: [
        { text: "void init", link: "/reference/cli#setup" },
        { text: "void auth", link: "/reference/cli#auth" },
        { text: "void project", link: "/reference/cli#project-commands" },
        { text: "void deploy", link: "/reference/cli#deploy" },
        { text: "void db", link: "/reference/cli#database" },
        { text: "void gen", link: "/reference/cli#code-generation" },
        { text: "void secret", link: "/reference/cli#secrets" },
        { text: "void domain", link: "/reference/cli#custom-domains" },
        { text: "void init --agents", link: "/reference/cli#agent" },
      ],
    },
  ],
};

const integrationLinks = {
  text: "Integrations",
  activeMatch: "/integrations/",
  items: [
    {
      text: "Meta Frameworks",
      collapsed: false,
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
    { text: "Coding Agents", link: "/integrations/agents" },
    { text: "Hono", link: "/integrations/hono" },
    { text: "Cloudflare", link: "/integrations/cloudflare" },
    { text: "Node.js / Bun / Deno", link: "/integrations/nodejs-bun-deno" },
    { text: "ORMs and External Databases", link: "/integrations/orms-and-external-dbs" },
    { text: "Auth Providers", link: "/integrations/auth-providers" },
    { text: "Payment Processors", link: "/integrations/payment-processors" },
  ],
};

const resourcesLinks = {
  text: "Resources",
  items: [
    { text: "Recipes", link: "/recipes/", activeMatch: "/recipes/" },
    { text: "Examples", link: "/examples/", activeMatch: "/examples/" },
    { text: "Blog", link: "https://voidzero.dev/blog" },
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
        { text: "Guide", link: "/guide/", activeMatch: "/guide/" },
        integrationLinks,
        referenceLinks,
        resourcesLinks,
      ],

      socialLinks: [
        { icon: "x", link: "https://x.com/voidcloudhq" },
        { icon: "discord", link: "https://discord.gg/cC6TEVFKSx" },
        { icon: "github", link: "https://github.com/voidzero-dev/void" },
      ],

      sidebar: {
        "/guide/": [
          {
            text: "Getting Started",
            collapsed: false,
            items: [
              { text: "Introduction", link: "/guide/" },
              { text: "Quickstart", link: "/guide/quickstart" },
            ],
          },
          {
            text: "Routing & Rendering",
            collapsed: false,
            items: [
              { text: "Server Routing", link: "/guide/server-routing" },
              {
                text: "Pages Routing",
                collapsed: false,
                items: [
                  { text: "Overview", link: "/guide/pages-routing/overview" },
                  { text: "Loaders & Actions", link: "/guide/pages-routing/loaders-actions" },
                  { text: "Layouts & Shared Data", link: "/guide/pages-routing/layouts" },
                  { text: "Forms", link: "/guide/pages-routing/forms" },
                  { text: "Deferred Props", link: "/guide/pages-routing/deferred-props" },
                  { text: "View Transitions", link: "/guide/pages-routing/view-transitions" },
                  { text: "Head Management", link: "/guide/pages-routing/head" },
                  { text: "Islands", link: "/guide/pages-routing/islands" },
                  { text: "Markdown", link: "/guide/pages-routing/markdown" },
                ],
              },
              { text: "Custom SSR", link: "/guide/ssr" },
              { text: "SSG", link: "/guide/ssg" },
            ],
          },
          {
            text: "Data",
            collapsed: false,
            items: [
              { text: "Type Safety", link: "/guide/type-safety" },
              { text: "Database", link: "/guide/database" },
              { text: "Typed Fetch", link: "/guide/typed-fetch" },
              { text: "Key-Value Storage", link: "/guide/kv" },
              { text: "Object Storage", link: "/guide/storage" },
            ],
          },
          {
            text: "Platform",
            collapsed: false,
            items: [
              { text: "Supported App Types", link: "/guide/app-types" },
              { text: "Deployment", link: "/guide/deployment" },
              {
                text: "Edge Routing",
                collapsed: false,
                items: [
                  { text: "Static Assets Caching", link: "/guide/edge/static-assets" },
                  { text: "Revalidation (ISR)", link: "/guide/edge/revalidation" },
                  { text: "Edge Prerendering", link: "/guide/edge/prerendering" },
                  { text: "Custom Headers", link: "/guide/edge/headers" },
                  { text: "Redirects", link: "/guide/edge/redirects" },
                ],
              },
              { text: "AI", link: "/guide/ai" },
              { text: "Authentication", link: "/guide/auth" },
              { text: "Cron Jobs", link: "/guide/jobs" },
              { text: "Queues", link: "/guide/queues" },
              { text: "Environment Variables", link: "/guide/env-vars" },
            ],
          },
        ],
        "/integrations/": [integrationLinks],
        "/reference/": [referenceLinks],
      },
    },
  }),
);
