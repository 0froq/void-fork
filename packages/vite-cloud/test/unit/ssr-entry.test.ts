import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSsrEntryPath, hasSsrEntry, validateSsrEntry } from "../../src/ssr/entry";

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
    expect(getSsrEntryPath(root)).toBeNull();
    expect(validateSsrEntry(root)).toBeNull();
  });

  it("validates exported render function", () => {
    const root = createTempRoot();
    const file = join(root, "src", "ssr.entry.ts");
    writeFileSync(
      file,
      "export async function render(request, env) { return new Response('ok'); }",
    );

    expect(hasSsrEntry(root)).toBe(true);
    expect(validateSsrEntry(root)).toBe(file);
  });

  it("supports tsx ssr entry files", () => {
    const root = createTempRoot();
    const file = join(root, "src", "ssr.entry.tsx");
    writeFileSync(
      file,
      "export async function render(request, env) { return new Response('<div>ok</div>'); }",
    );

    expect(hasSsrEntry(root)).toBe(true);
    expect(validateSsrEntry(root)).toBe(file);
  });

  it("throws when both ts and tsx ssr entries exist", () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, "src", "ssr.entry.ts"),
      "export async function render(request, env) { return new Response('ok'); }",
    );
    writeFileSync(
      join(root, "src", "ssr.entry.tsx"),
      "export async function render(request, env) { return new Response('ok'); }",
    );

    expect(() => validateSsrEntry(root)).toThrow("Multiple SSR entry files found");
  });

  it("throws for missing render export", () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, "src", "ssr.entry.ts"),
      "export const notRender = () => new Response('ok');",
    );

    expect(() => validateSsrEntry(root)).toThrow("expected `export function render(request, env)`");
  });
});
