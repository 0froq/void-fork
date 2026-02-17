import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const docsDir = path.resolve(import.meta.dirname, "../../../website/docs");

describe("build-docs", () => {
  const files = fs
    .readdirSync(docsDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  it("finds markdown files in docs directory", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("all files end with .md", () => {
    for (const file of files) {
      expect(file).toMatch(/\.md$/);
    }
  });

  it.each(files)("%s has a top-level heading", (file) => {
    const content = fs.readFileSync(path.join(docsDir, file), "utf-8");
    // After stripping optional frontmatter, first heading should exist
    const stripped = content.replace(/^---\n[\s\S]*?\n---\n/, "");
    expect(stripped).toMatch(/^#\s+.+/m);
  });

  it("generated docs.ts exists and exports all pages", async () => {
    const generated = path.resolve(import.meta.dirname, "../../src/docs.ts");
    // The generated file should exist (build:docs must have been run)
    expect(fs.existsSync(generated)).toBe(true);

    const { docs } = await import("../../src/docs");
    expect(docs.length).toBe(files.length);
  });

  it("generated docs have correct slugs", async () => {
    const { docs } = await import("../../src/docs");
    const expectedSlugs = files.map((f) => f.replace(/\.md$/, ""));
    const actualSlugs = docs.map((d: { slug: string }) => d.slug);
    expect(actualSlugs).toEqual(expectedSlugs);
  });

  it("generated docs have non-empty titles", async () => {
    const { docs } = await import("../../src/docs");
    for (const page of docs) {
      expect(page.title.length).toBeGreaterThan(0);
    }
  });

  it("generated docs have non-empty content", async () => {
    const { docs } = await import("../../src/docs");
    for (const page of docs) {
      expect(page.content.length).toBeGreaterThan(0);
    }
  });

  it("strips YAML frontmatter from content", async () => {
    const { docs } = await import("../../src/docs");
    for (const page of docs) {
      expect(page.content).not.toMatch(/^---\n/);
    }
  });
});
