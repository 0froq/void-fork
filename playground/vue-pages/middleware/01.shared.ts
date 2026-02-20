import { defineMiddleware } from "vite-cloud";

export default defineMiddleware(async (c, next) => {
  c.set("shared", {
    appName: "Vue Pages Demo",
  });
  await next();
});
