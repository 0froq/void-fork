import { defineMiddleware } from "vite-cloud";

declare module "vite-cloud" {
  interface CloudContextVariables {
    shared: { appName: string };
  }
}

export default defineMiddleware(async (c, next) => {
  c.set("shared", {
    appName: "React Pages Demo",
  });
  await next();
});
