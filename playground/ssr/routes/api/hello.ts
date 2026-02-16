import { defineHandler } from "vite-cloud";

export const GET = defineHandler(() => {
  return { message: "Hello from SSR playground" };
});
