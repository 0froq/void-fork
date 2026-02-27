import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/unit/**/*.test.ts"],
          sequence: { groupOrder: 1 },
        },
      },
      {
        test: {
          name: "core-markdown",
          maxWorkers: 3,
          sequence: { groupOrder: 2 },
          include: [
            "packages/void/test/integration/**/*.test.ts",
            "packages/md/test/integration/**/*.test.ts",
          ],
          exclude: [
            "packages/void/test/integration/astro.test.ts",
            "packages/void/test/integration/nuxt.test.ts",
            "packages/void/test/integration/sveltekit.test.ts",
            "packages/void/test/integration/tanstack-start.test.ts",
          ],
        },
      },
      {
        test: {
          name: "metaframeworks",
          maxWorkers: 3,
          sequence: { groupOrder: 2 },
          include: [
            "packages/void/test/integration/astro.test.ts",
            "packages/void/test/integration/nuxt.test.ts",
            "packages/void/test/integration/sveltekit.test.ts",
            "packages/void/test/integration/tanstack-start.test.ts",
          ],
        },
      },
      {
        test: {
          name: "pages-react-vue",
          maxWorkers: 3,
          sequence: { groupOrder: 2 },
          include: [
            "packages/react/test/integration/**/*.test.ts",
            "packages/vue/test/integration/**/*.test.ts",
          ],
        },
      },
      {
        test: {
          name: "pages-svelte-solid",
          maxWorkers: 3,
          sequence: { groupOrder: 2 },
          include: [
            "packages/svelte/test/integration/**/*.test.ts",
            "packages/solid/test/integration/**/*.test.ts",
          ],
        },
      },
    ],
  },
});
