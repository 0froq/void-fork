import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectWorkerDir } from "../../src/cli/deploy";
import {
  getRequestedProjectSlug,
  inferDefaultSlug,
  resolveProjectBySlug,
} from "../../src/cli/resolve-project";
import type { ProjectResponse } from "../../src/cli/client";

const tempDirs: string[] = [];

describe("getRequestedProjectSlug", () => {
  afterEach(() => {
    delete process.env.VOID_PROJECT;
  });

  it("prefers CLI project slug over env var", () => {
    process.env.VOID_PROJECT = "from-env";
    expect(getRequestedProjectSlug({ projectSlug: "from-cli" })).toBe("from-cli");
  });

  it("uses env var when CLI slug is missing", () => {
    process.env.VOID_PROJECT = "from-env";
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

  it("returns null when slug is not found", () => {
    expect(resolveProjectBySlug([], "missing")).toBeNull();
  });

  it("returns null when slug does not match any project", () => {
    const projects = [
      { id: "proj_1", slug: "app-one" },
      { id: "proj_2", slug: "app-two" },
    ] as ProjectResponse[];
    expect(resolveProjectBySlug(projects, "missing")).toBeNull();
  });
});

describe("inferDefaultSlug", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives slug from a scoped package name", () => {
    const root = mkdtempSync(join(tmpdir(), "void-test-"));
    tempDirs.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@acme/my-app" }));

    expect(inferDefaultSlug(root)).toBe("my-app");
  });

  it("uses fallback values when package name is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "void-test-"));
    tempDirs.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({}));

    expect(inferDefaultSlug(root)).toBe("my-app");
  });
});

describe("detectWorkerDir", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 'ssr' when dist/ssr exists", () => {
    const root = mkdtempSync(join(tmpdir(), "void-test-"));
    tempDirs.push(root);
    const dist = join(root, "dist");
    mkdirSync(join(dist, "ssr"), { recursive: true });

    expect(detectWorkerDir(dist)).toBe("ssr");
  });

  it("throws when dist/ssr does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "void-test-"));
    tempDirs.push(root);
    const dist = join(root, "dist");
    mkdirSync(dist, { recursive: true });

    expect(() => detectWorkerDir(dist)).toThrow("Worker output not found");
  });
});
