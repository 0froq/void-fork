import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectWorkerDir,
  getRequestedProjectSlug,
  inferDefaultProjectNameAndSlug,
  resolveProjectBySlug,
} from "../../src/cli/deploy";

const tempDirs: string[] = [];

function getError(fn: () => void): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("Expected function to throw");
}

describe("getRequestedProjectSlug", () => {
  afterEach(() => {
    delete process.env.VITE_CLOUD_PROJECT;
  });

  it("prefers CLI project slug over env var", () => {
    process.env.VITE_CLOUD_PROJECT = "from-env";
    expect(getRequestedProjectSlug({ projectSlug: "from-cli" })).toBe("from-cli");
  });

  it("uses env var when CLI slug is missing", () => {
    process.env.VITE_CLOUD_PROJECT = "from-env";
    expect(getRequestedProjectSlug()).toBe("from-env");
  });

  it("returns null when no override exists", () => {
    expect(getRequestedProjectSlug()).toBeNull();
  });
});

describe("resolveProjectBySlug", () => {
  it("returns project config for a matching slug", () => {
    const config = resolveProjectBySlug(
      [
        {
          id: "proj_1",
          user_id: "user_1",
          slug: "my-app",
          name: "My App",
          mode: "worker",
          created_at: "2026-02-15T00:00:00.000Z",
          custom_domain: null,
        },
      ],
      "my-app",
    );

    expect(config).toEqual({
      projectId: "proj_1",
      slug: "my-app",
    });
  });

  it("throws when slug is not found (no projects)", () => {
    expect(() => resolveProjectBySlug([], "missing")).toThrow(
      /No project found with slug "missing"[\s\S]*You have no projects yet/,
    );
  });

  it("throws when slug is not found (lists available)", () => {
    const projects = [
      { id: "proj_1", slug: "app-one", name: "App One" },
      { id: "proj_2", slug: "app-two", name: "App Two" },
    ] as ProjectResponse[];
    const err = getError(() => resolveProjectBySlug(projects, "missing"));
    expect(err.message).toContain('No project found with slug "missing"');
    expect(err.message).toContain("Available projects:");
    expect(err.message).toContain("  - app-one");
    expect(err.message).toContain("  - app-two");
  });
});

describe("inferDefaultProjectNameAndSlug", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives slug from a scoped package name", () => {
    const root = mkdtempSync(join(tmpdir(), "vite-cloud-test-"));
    tempDirs.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@acme/my-app" }));

    expect(inferDefaultProjectNameAndSlug(root)).toEqual({
      name: "@acme/my-app",
      slug: "my-app",
    });
  });

  it("uses fallback values when package name is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "vite-cloud-test-"));
    tempDirs.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({}));

    expect(inferDefaultProjectNameAndSlug(root)).toEqual({
      name: "my-app",
      slug: "my-app",
    });
  });
});

describe("detectWorkerDir", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses expected dist/<environment-name> when present", () => {
    const root = mkdtempSync(join(tmpdir(), "vite-cloud-test-"));
    tempDirs.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "star-tracker" }));
    const dist = join(root, "dist");
    mkdirSync(join(dist, "star_tracker"), { recursive: true });

    expect(detectWorkerDir(root, dist)).toBe("star_tracker");
  });

  it("falls back to single non-client directory for custom output dirs", () => {
    const root = mkdtempSync(join(tmpdir(), "vite-cloud-test-"));
    tempDirs.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "star-tracker" }));
    const dist = join(root, "dist");
    mkdirSync(join(dist, "worker"), { recursive: true });
    mkdirSync(join(dist, "client"), { recursive: true });

    expect(detectWorkerDir(root, dist)).toBe("worker");
  });

  it("throws when multiple fallback candidates exist", () => {
    const root = mkdtempSync(join(tmpdir(), "vite-cloud-test-"));
    tempDirs.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "star-tracker" }));
    const dist = join(root, "dist");
    mkdirSync(join(dist, "worker-a"), { recursive: true });
    mkdirSync(join(dist, "worker-b"), { recursive: true });

    expect(() => detectWorkerDir(root, dist)).toThrow(
      "Could not determine worker output directory",
    );
  });

  it("derives env dir for scoped package names", () => {
    const root = mkdtempSync(join(tmpdir(), "vite-cloud-test-"));
    tempDirs.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@acme/star-tracker" }));
    const dist = join(root, "dist");
    mkdirSync(join(dist, "star_tracker"), { recursive: true });

    expect(detectWorkerDir(root, dist)).toBe("star_tracker");
  });
});
