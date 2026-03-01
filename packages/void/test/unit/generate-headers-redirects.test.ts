import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { generateRedirectsFile } from "../../src/cli/headers";

const tmpDir = join(import.meta.dirname, ".tmp-generate-static-files-test");
const clientDir = join(tmpDir, "client");

function setup(opts?: { existingRedirects?: string }) {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(clientDir, { recursive: true });
  if (opts?.existingRedirects) {
    writeFileSync(join(clientDir, "_redirects"), opts.existingRedirects);
  }
}

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("generateRedirectsFile", () => {
  it("generates _redirects from config", () => {
    setup();
    generateRedirectsFile(clientDir, {
      "/old": "/new",
      "/blog/*": { to: "/posts/:splat", status: 301 },
    });
    const content = readFileSync(join(clientDir, "_redirects"), "utf-8");
    expect(content).toContain("/old /new 302");
    expect(content).toContain("/blog/* /posts/:splat 301");
  });

  it("does nothing when no config provided", () => {
    setup();
    generateRedirectsFile(clientDir, undefined);
    expect(existsSync(join(clientDir, "_redirects"))).toBe(false);
  });

  it("does nothing when config is empty", () => {
    setup();
    generateRedirectsFile(clientDir, {});
    expect(existsSync(join(clientDir, "_redirects"))).toBe(false);
  });

  it("does not overwrite existing _redirects file", () => {
    setup({ existingRedirects: "/user-rule /dest 301\n" });
    generateRedirectsFile(clientDir, { "/old": "/new" });
    const content = readFileSync(join(clientDir, "_redirects"), "utf-8");
    expect(content).toBe("/user-rule /dest 301\n");
  });
});
