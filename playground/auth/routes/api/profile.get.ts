import { defineHandler } from "vite-cloud";
import { requireAuth } from "vite-cloud/auth";

export default defineHandler((c) => {
  const user = requireAuth(c);
  return { user };
});
