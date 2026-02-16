import { defineHandler } from "vite-cloud";
import { requireAuth } from "vite-cloud/auth";

export const GET = defineHandler((c) => {
  const user = requireAuth(c);
  return { user };
});
