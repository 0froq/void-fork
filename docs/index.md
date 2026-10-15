---
layout: home
theme: dark

hero:
  name: Void
  text: Build with Vite. Deploy with Void.
  tagline: Void is a CLI, platform, and full-stack SDK that unifies building & deploying apps
  actions:
    - theme: brand
      text: Get Started
      link: ./guide/
    - theme: alt
      text: View on Github
      link: https://github.com/voidzero-dev/void
features:
  - iconify: lucide:layers
    visual: stack
    title: Full-Stack Features
    details: Add full-stack features to your app as you need them without having to wire it all together yourself.
    highlights:
      - Server routes, edge routing and pages
      - Authentication
      - AI, queues, and scheduled jobs
    guide:
      text: Explore app types
      link: /guide/app-types
  - iconify: lucide:wand-sparkles
    visual: resources
    title: Resources from Your Code
    details: Void detects supported resources from your imports and provisions them on deploy. Configure existing resources explicitly.
    highlights:
      - Database, KV, and storage inferred from imports
      - Local resources for development
      - Types shared between server loaders and pages
    guide:
      text: Resource inference guide
      link: /reference/resource-inference
  - iconify: lucide:blocks
    visual: frameworks
    title: Choose Your Framework
    details: 'Scale your apps based on what you need: API-only, SPA + API, or full-stack.'
    highlights:
      - Native pages with React, Vue, Svelte, or Solid
      - Supports TanStack Start, React Router, SvelteKit, Nuxt, Analog, and Astro v6+
      - Rendering options including SSR, SSG, ISR, and islands
    guide:
      text: Framework integrations
      link: /integrations/frameworks/overview
platform_features:
  - id: platform-ai-coding
    iconify: lucide:bot
    title: Secure Vibe Coding for Your Team
    details: Let your team build and deploy with coding agents while admins retain control of Cloudflare access.
    highlights:
      - Keep Cloudflare credentials with your admin team
      - Enable non-technical teammates to build their own apps
      - Deploy prototypes fast and share apps for feedback
    guide:
      text: Explore team deployments
      link: /guide/self-hosted-platform
    visual: rive
    image_alt: Animated illustration of apps being built for a team
  - id: platform-control-plane
    iconify: lucide:panels-top-left
    visual: resources
    title: Control Plane for Managing Apps
    details: Manage users, projects, deployments, and platform health from the admin UI or CLI.
    highlights:
      - Manage users and project access & resources
      - Inspect deployments, logs, and rollbacks
      - Monitor platform health and usage
    guide:
      text: Platform administration
      link: /guide/platform-administration
    image_alt: List of Void platform commands for access, builds, invitations, and administration
  - id: platform-security
    iconify: lucide:shield-check
    title: Bring your Own Security
    details: Fork and customize your own Void platform based on your team's security standards.
    highlights:
      - Manage access through Cloudflare Access, Google, GitHub, or OIDC
      - Control who can sign in and deploy
      - Protect projects with your access policies
    guide:
      text: Configure platform access
      link: /guide/platform/administration/access
    visual: rive
    image_alt: Animated illustration of self-hosted platform security
footer_heading: Build with Vite. Deploy with Void.
footer_subheading: Server code, resources, and deployment in one workflow.
---

<script setup>
import Home from './.vitepress/theme/Home.vue'
</script>

<Home />
