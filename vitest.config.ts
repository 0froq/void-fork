import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // cloudflare:workers is only available in the Workers runtime.
      // Provide a lightweight stub so tests can import modules that use DurableObject.
      "cloudflare:workers": fileURLToPath(
        new URL("packages/api/test/__mocks__/cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
