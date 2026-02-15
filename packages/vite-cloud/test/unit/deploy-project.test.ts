import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getRequestedProjectSlug,
  inferDefaultProjectNameAndSlug,
  resolveProjectBySlug,
} from "../../src/cli/deploy";

const tempDirs: string[] = [];

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
          created_at: "2026-02-15T00:00:00.000Z",
        },
      ],
      "my-app",
    );

    expect(config).toEqual({
      projectId: "proj_1",
      slug: "my-app",
    });
  });

  it("throws when slug is not found", () => {
    expect(() => resolveProjectBySlug([], "missing")).toThrow(
      'No project found with slug "missing".',
    );
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
