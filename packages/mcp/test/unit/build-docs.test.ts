import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildDocs } from "../../scripts/build-docs";

const docsDir = path.resolve(import.meta.dirname, "../../../website/docs");

describe("build-docs", () => {
  const files = fs
    .readdirSync(docsDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  const docs = buildDocs();

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

  it("builds all pages", () => {
    expect(docs.length).toBe(files.length);
  });

  it("has correct slugs", () => {
    const expectedSlugs = files.map((f) => f.replace(/\.md$/, ""));
    const actualSlugs = docs.map((d) => d.slug);
    expect(actualSlugs).toEqual(expectedSlugs);
  });

  it("has non-empty titles", () => {
    for (const page of docs) {
      expect(page.title.length).toBeGreaterThan(0);
    }
  });

  it("has non-empty content", () => {
    for (const page of docs) {
      expect(page.content.length).toBeGreaterThan(0);
    }
  });

  it("strips YAML frontmatter from content", () => {
    for (const page of docs) {
      expect(page.content).not.toMatch(/^---\n/);
    }
  });
});
