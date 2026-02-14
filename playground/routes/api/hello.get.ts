import { defineHandler } from "vite-plugin-cloud";

export default defineHandler(() => {
  return { message: "Hello from Vite Cloud!", timestamp: Date.now() };
});
