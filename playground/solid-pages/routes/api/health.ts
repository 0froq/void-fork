import { defineHandler } from "vite-cloud";

export const GET = defineHandler(() => {
  return { status: "ok" };
});
