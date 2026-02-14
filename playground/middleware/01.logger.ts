import { defineHandler } from "vite-plugin-cloud";

export default defineHandler((ctx) => {
  const url = new URL(ctx.request.url);
  console.log(`[${ctx.request.method}] ${url.pathname}`);
});
