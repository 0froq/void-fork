import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { packageBuild, packageStaticBuild } from "../../src/cli/package";

const TMP = join(import.meta.dirname, ".tmp-package-test");

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("packageStaticBuild", () => {
  it("includes all assets in form data", () => {
    writeFileSync(join(TMP, "a.html"), "a");
    writeFileSync(join(TMP, "b.js"), "b");

    const form = packageStaticBuild(TMP, "spa");

    const assetKeys: string[] = [];
    for (const [key] of form.entries()) {
      if (key.startsWith("asset:")) {
        assetKeys.push(key.slice("asset:".length));
      }
    }

    expect(assetKeys.sort()).toEqual(["a.html", "b.js"]);
  });

  it("sets version 2 in manifest", () => {
    writeFileSync(join(TMP, "index.html"), "x");

    const form = packageStaticBuild(TMP, "spa");

    const manifestRaw = form.get("manifest") as string;
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.version).toBe(2);
  });

  it("sets assetConfig for SPA mode", () => {
    writeFileSync(join(TMP, "index.html"), "x");

    const form = packageStaticBuild(TMP, "spa");

    const manifestRaw = form.get("manifest") as string;
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.assetConfig).toEqual({
      not_found_handling: "single-page-application",
    });
  });

  it("sets assetConfig for prebuilt mode", () => {
    writeFileSync(join(TMP, "index.html"), "x");

    const form = packageStaticBuild(TMP, "prebuilt");

    const manifestRaw = form.get("manifest") as string;
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.assetConfig).toEqual({
      not_found_handling: "404-page",
    });
  });
});

describe("packageBuild", () => {
  it("excludes .vite/ directory from worker files", () => {
    // Set up dist/worker/ with worker files and .vite/manifest.json
    const workerDir = join(TMP, "worker");
    mkdirSync(join(workerDir, ".vite"), { recursive: true });
    mkdirSync(join(workerDir, "assets"), { recursive: true });
    writeFileSync(join(workerDir, "index.js"), "export default {}");
    writeFileSync(join(workerDir, "assets", "chunk.js"), "var x = 1");
    writeFileSync(join(workerDir, ".vite", "manifest.json"), '{"key":"value"}');

    const form = packageBuild(TMP, "worker", {
      needsD1: false,
      needsKV: false,
      needsR2: false,
      needsAuth: false,
      needsQueues: false,
      needsAI: false,
    });

    const workerKeys: string[] = [];
    for (const [key] of form.entries()) {
      if (key.startsWith("worker:")) {
        workerKeys.push(key.slice("worker:".length));
      }
    }

    expect(workerKeys.sort()).toEqual(["assets/chunk.js", "index.js"]);
    expect(workerKeys).not.toContain(".vite/manifest.json");
  });

  it("sets version 2 in manifest", () => {
    const workerDir = join(TMP, "worker");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "index.js"), "export default {}");

    const form = packageBuild(TMP, "worker", {
      needsD1: false,
      needsKV: false,
      needsR2: false,
      needsAuth: false,
      needsQueues: false,
      needsAI: false,
    });

    const manifestRaw = form.get("manifest") as string;
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.version).toBe(2);
  });
});
