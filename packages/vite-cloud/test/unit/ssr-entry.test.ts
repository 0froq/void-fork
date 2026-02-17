import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getPrerenderConfig,
  getRevalidateConfig,
  getSsrPrerenderPaths,
  getSsrServerEntryPath,
  hasSsrEntry,
  validateSsrEntry,
} from "../../src/ssr/entry";

const tempDirs: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "vite-cloud-ssr-entry-"));
  tempDirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  return root;
}

describe("ssr entry helpers", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when ssr entry is missing", () => {
    const root = createTempRoot();
    expect(hasSsrEntry(root)).toBe(false);
    expect(getSsrServerEntryPath(root)).toBeNull();
    expect(validateSsrEntry(root)).toBeNull();
  });

  it("validates exported render function", () => {
    const root = createTempRoot();
    const file = join(root, "src", "main.ssr.ts");
    writeFileSync(
      join(root, "src", "main.client.tsx"),
      "import { hydrateRoot } from 'react-dom/client'; hydrateRoot(document, null);",
    );
    writeFileSync(
      file,
      "export async function render(request, env) { return new Response('ok'); }",
    );

    expect(hasSsrEntry(root)).toBe(true);
    expect(validateSsrEntry(root)).toBe(file);
  });

  it("supports tsx ssr entry files", () => {
    const root = createTempRoot();
    const file = join(root, "src", "main.ssr.tsx");
    writeFileSync(join(root, "src", "main.client.ts"), "console.log('client entry');");
    writeFileSync(
      file,
      "export async function render(request, env) { return new Response('<div>ok</div>'); }",
    );

    expect(hasSsrEntry(root)).toBe(true);
    expect(validateSsrEntry(root)).toBe(file);
  });

  it("supports default defineRender export", () => {
    const root = createTempRoot();
    const file = join(root, "src", "main.ssr.ts");
    writeFileSync(join(root, "src", "main.client.ts"), "console.log('client entry');");
    writeFileSync(
      file,
      "import { defineRender } from 'vite-cloud'; export default defineRender(async () => new Response('ok'));",
    );

    expect(hasSsrEntry(root)).toBe(true);
    expect(validateSsrEntry(root)).toBe(file);
  });

  it("throws when both ts and tsx ssr entries exist", () => {
    const root = createTempRoot();
    writeFileSync(join(root, "src", "main.client.ts"), "console.log('client entry');");
    writeFileSync(
      join(root, "src", "main.ssr.ts"),
      "export async function render(request, env) { return new Response('ok'); }",
    );
    writeFileSync(
      join(root, "src", "main.ssr.tsx"),
      "export async function render(request, env) { return new Response('ok'); }",
    );

    expect(() => validateSsrEntry(root)).toThrow("Multiple SSR entry files found");
  });

  it("throws for missing render export", () => {
    const root = createTempRoot();
    writeFileSync(join(root, "src", "main.client.ts"), "console.log('client entry');");
    writeFileSync(
      join(root, "src", "main.ssr.ts"),
      "export const notRender = () => new Response('ok');",
    );

    expect(() => validateSsrEntry(root)).toThrow(
      "expected `export function render(c, assetTags)` or `export default defineRender(...)`",
    );
  });

  it("throws when server entry exists without client entry", () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, "src", "main.ssr.ts"),
      "export async function render(request, env) { return new Response('ok'); }",
    );

    expect(() => validateSsrEntry(root)).toThrow("SSR mode requires a client entry");
  });

  it("throws when client entry exists without server entry", () => {
    const root = createTempRoot();
    writeFileSync(join(root, "src", "main.client.ts"), "console.log('client entry');");

    expect(() => validateSsrEntry(root)).toThrow("SSR mode requires a server entry");
  });

  it("reads prerender paths and normalizes trailing slashes", () => {
    const root = createTempRoot();
    writeFileSync(join(root, "src", "main.client.ts"), "console.log('client entry');");
    writeFileSync(
      join(root, "src", "main.ssr.ts"),
      `
      export const prerender = ["/", "/about/", "/pricing"];
      export async function render(c, assetTags) { return new Response("ok"); }
      `,
    );

    expect(getSsrPrerenderPaths(root)).toEqual(["/", "/about", "/pricing"]);
  });

  it("rejects invalid prerender paths", () => {
    const root = createTempRoot();
    writeFileSync(join(root, "src", "main.client.ts"), "console.log('client entry');");
    writeFileSync(
      join(root, "src", "main.ssr.ts"),
      `
      export const prerender = ["about", "/blog/:slug", "/a", "/a"];
      export async function render(c, assetTags) { return new Response("ok"); }
      `,
    );

    expect(() => getSsrPrerenderPaths(root)).toThrow("Invalid SSR prerender export");
  });
});

describe("getPrerenderConfig", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns none when no SSR entry exists", () => {
    const root = createTempRoot();
    expect(getPrerenderConfig(root)).toEqual({ type: "none" });
  });

  it("returns none when no prerender export exists", () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, "src", "main.ssr.ts"),
      "export async function render(c, assetTags) { return new Response('ok'); }",
    );
    expect(getPrerenderConfig(root)).toEqual({ type: "none" });
  });

  it("returns static with paths for array export", () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, "src", "main.ssr.ts"),
      `
      export const prerender = ["/", "/about", "/pricing"];
      export async function render(c, assetTags) { return new Response("ok"); }
      `,
    );
    expect(getPrerenderConfig(root)).toEqual({
      type: "static",
      paths: ["/", "/about", "/pricing"],
    });
  });

  it("returns function for arrow function export", () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, "src", "main.ssr.ts"),
      `
      export const prerender = async () => {
        return ["/", "/about"];
      };
      export async function render(c, assetTags) { return new Response("ok"); }
      `,
    );
    expect(getPrerenderConfig(root)).toEqual({ type: "function" });
  });

  it("returns function for function expression export", () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, "src", "main.ssr.ts"),
      `
      export const prerender = async function() {
        return ["/", "/about"];
      };
      export async function render(c, assetTags) { return new Response("ok"); }
      `,
    );
    expect(getPrerenderConfig(root)).toEqual({ type: "function" });
  });

  it("returns function for named function declaration export", () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, "src", "main.ssr.ts"),
      `
      export async function prerender() {
        return ["/", "/about"];
      }
      export async function render(c, assetTags) { return new Response("ok"); }
      `,
    );
    expect(getPrerenderConfig(root)).toEqual({ type: "function" });
  });

  it("rejects glob patterns in static array", () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, "src", "main.ssr.ts"),
      `
      export const prerender = ["/", "/blog/*"];
      export async function render(c, assetTags) { return new Response("ok"); }
      `,
    );
    expect(() => getPrerenderConfig(root)).toThrow("must not be dynamic");
  });
});

describe("getRevalidateConfig", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns none when no SSR entry exists", () => {
    const root = createTempRoot();
    expect(getRevalidateConfig(root)).toEqual({ type: "none" });
  });

  it("returns none when no revalidate export exists", () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, "src", "main.ssr.ts"),
      "export async function render(c, assetTags) { return new Response('ok'); }",
    );
    expect(getRevalidateConfig(root)).toEqual({ type: "none" });
  });

  it("returns static with ttl for numeric export", () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, "src", "main.ssr.ts"),
      `
      export const revalidate = 60;
      export async function render(c, assetTags) { return new Response("ok"); }
      `,
    );
    expect(getRevalidateConfig(root)).toEqual({ type: "static", ttl: 60 });
  });

  it("returns static with ttl 0 for zero value (opt-out)", () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, "src", "main.ssr.ts"),
      `
      export const revalidate = 0;
      export async function render(c, assetTags) { return new Response("ok"); }
      `,
    );
    expect(getRevalidateConfig(root)).toEqual({ type: "static", ttl: 0 });
  });

  it("rejects negative values", () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, "src", "main.ssr.ts"),
      `
      export const revalidate = -10;
      export async function render(c, assetTags) { return new Response("ok"); }
      `,
    );
    expect(() => getRevalidateConfig(root)).toThrow("non-negative number");
  });

  it("rejects non-numeric values", () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, "src", "main.ssr.ts"),
      `
      export const revalidate = "60";
      export async function render(c, assetTags) { return new Response("ok"); }
      `,
    );
    expect(() => getRevalidateConfig(root)).toThrow("expected a numeric literal");
  });
});
