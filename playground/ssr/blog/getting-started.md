# Getting Started with Vite Cloud

This guide walks you through setting up a Vite Cloud project with SSR and blog support.

## Prerequisites

- Node.js 22+
- pnpm 10+

## Steps

1. Create a new project with `npm create vite-cloud`
2. Add `src/main.ssr.tsx` and `src/main.client.tsx` for SSR mode
3. Export a `prerender` function to generate static pages at build time
4. Deploy with `vite-cloud deploy`
