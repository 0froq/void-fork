import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  rewriteManifestForPublish,
  toPublicPackageName,
} from "../../../../scripts/rewrite-package-manifest.js";

function readPackageJson(relativePath: string): Record<string, any> {
  const root = join(import.meta.dirname, "../../../../");
  return JSON.parse(readFileSync(join(root, relativePath), "utf-8"));
}

describe("rewrite-package-manifest", () => {
  it("maps preview package names to public package names", () => {
    expect(toPublicPackageName("@void-sdk/void")).toBe("void");
    expect(toPublicPackageName("@void-sdk/react")).toBe("@void/react");
    expect(toPublicPackageName("vite")).toBe("vite");
  });

  it("rewrites adapter peerDependencies to public void semver", () => {
    const reactManifest = readPackageJson("packages/react/package.json");
    const voidManifest = readPackageJson("packages/void/package.json");
    const rewritten = rewriteManifestForPublish(reactManifest);

    expect(rewritten.peerDependencies.void).toBe(`^${voidManifest.version}`);
  });

  it("rewrites void optional framework peers to public names", () => {
    const voidManifest = readPackageJson("packages/void/package.json");
    const rewritten = rewriteManifestForPublish(voidManifest);
    const previewFrameworkPeers = Object.keys(voidManifest.peerDependencies).filter((name) =>
      name.startsWith("@void-sdk/"),
    );

    for (const previewName of previewFrameworkPeers) {
      const packageDir = previewName.replace(/^@void-sdk\//, "");
      const frameworkManifest = readPackageJson(`packages/${packageDir}/package.json`);
      const publicName = toPublicPackageName(previewName);

      expect(rewritten.peerDependencies[publicName]).toBe(`^${frameworkManifest.version}`);
      expect(rewritten.peerDependenciesMeta[publicName]).toEqual(
        voidManifest.peerDependenciesMeta[previewName],
      );
      expect(rewritten.peerDependencies[previewName]).toBeUndefined();
      expect(rewritten.peerDependenciesMeta[previewName]).toBeUndefined();
    }
  });
});
