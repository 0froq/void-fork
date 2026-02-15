import { defineHandler } from "vite-cloud";

export default defineHandler(() => {
  return { message: "Hello from Vite Cloud!", timestamp: Date.now() };
});
