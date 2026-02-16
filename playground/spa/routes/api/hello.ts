import { defineHandler } from "vite-cloud";

export const GET = defineHandler(() => {
  return { message: "Hello from Vite Cloud!", timestamp: Date.now() };
});
