import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { generateHeadersFile, generateRedirectsFile } from "../../src/cli/headers";

const tmpDir = join(import.meta.dirname, ".tmp-generate-static-files-test");
const clientDir = join(tmpDir, "client");

function setup(opts?: { existingHeaders?: string; existingRedirects?: string }) {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(clientDir, { recursive: true });
  if (opts?.existingHeaders) {
    writeFileSync(join(clientDir, "_headers"), opts.existingHeaders);
  }
  if (opts?.existingRedirects) {
    writeFileSync(join(clientDir, "_redirects"), opts.existingRedirects);
  }
}

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("generateHeadersFile", () => {
  it("generates default cache headers when no config and no existing file", () => {
    setup();
    generateHeadersFile(clientDir, undefined, "assets");
    const content = readFileSync(join(clientDir, "_headers"), "utf-8");
    expect(content).toContain("/assets/*");
    expect(content).toContain("Cache-Control: public, max-age=31536000, immutable");
    expect(content).toContain("/*");
    expect(content).toContain("Cache-Control: public, s-maxage=60, max-age=0, must-revalidate");
  });

  it("appends void.json headers after defaults", () => {
    setup();
    const headers = { "/api/*": ["Access-Control-Allow-Origin: *"] };
    generateHeadersFile(clientDir, headers, "assets");
    const content = readFileSync(join(clientDir, "_headers"), "utf-8");
    expect(content).toContain("/api/*");
    expect(content).toContain("Access-Control-Allow-Origin: *");
    // Defaults should still be there
    expect(content).toContain("/assets/*");
  });

  it("does not overwrite existing _headers file", () => {
    setup({ existingHeaders: "# user file\n/*\n  X-Custom: yes\n" });
    generateHeadersFile(clientDir, { "/api/*": ["X-Foo: bar"] }, "assets");
    const content = readFileSync(join(clientDir, "_headers"), "utf-8");
    expect(content).toBe("# user file\n/*\n  X-Custom: yes\n");
  });

  it("uses custom assets prefix", () => {
    setup();
    generateHeadersFile(clientDir, undefined, "_nuxt");
    const content = readFileSync(join(clientDir, "_headers"), "utf-8");
    expect(content).toContain("/_nuxt/*");
    expect(content).not.toContain("/assets/*");
  });
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
