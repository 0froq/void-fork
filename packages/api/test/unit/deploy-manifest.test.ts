import { describe, it, expect } from "vitest";
import { SUPPORTED_MANIFEST_VERSIONS } from "../../src/types";
import type { DeployManifest } from "../../src/types";

describe("DeployManifest contract", () => {
  it("has a version field", () => {
    const manifest: DeployManifest = {
      version: 2,
      bindings: {},
    };
    expect(manifest.version).toBe(2);
  });

  it("supports version 2", () => {
    expect(SUPPORTED_MANIFEST_VERSIONS).toContain(2);
  });

  it("accepts a full manifest shape", () => {
    const manifest: DeployManifest = {
      version: 2,
      bindings: {
        d1: ["DB"],
        kv: ["KV"],
        r2: ["STORAGE"],
        ai: true,
      },
      migrations: [{ name: "0001_init.sql", destructive: false }],
      schedules: [{ name: "cleanup", cron: "0 * * * *" }],
      queues: [{ name: "emails", bindingName: "EMAIL_QUEUE" }],
      ssr: true,
      framework: "sveltekit",
      revalidate: 60,
      prerender: ["/", "/about"],
      assetConfig: {
        not_found_handling: "single-page-application",
        html_handling: "auto-trailing-slash",
      },
      vars: { NODE_ENV: "production" },
      workerMain: "index.mjs",
      compatibilityDate: "2026-02-24",
      compatibilityFlags: ["nodejs_compat", "nodejs_als"],
    };

    expect(manifest.version).toBe(2);
    expect(manifest.bindings.d1).toEqual(["DB"]);
    expect(manifest.migrations).toHaveLength(1);
    expect(manifest.schedules).toHaveLength(1);
    expect(manifest.queues).toHaveLength(1);
    expect(manifest.workerMain).toBe("index.mjs");
    expect(manifest.compatibilityDate).toBe("2026-02-24");
    expect(manifest.compatibilityFlags).toEqual(["nodejs_compat", "nodejs_als"]);
  });

  it("rejects unknown manifest versions", () => {
    expect(SUPPORTED_MANIFEST_VERSIONS.includes(999)).toBe(false);
  });
});
