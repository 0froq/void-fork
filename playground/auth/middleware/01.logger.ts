import { defineMiddleware } from "vite-cloud";

export default defineMiddleware(async (c, next) => {
  console.log(`[${c.req.method}] ${c.req.path}`);
  await next();
});
