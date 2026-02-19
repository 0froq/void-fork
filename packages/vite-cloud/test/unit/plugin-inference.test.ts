import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inferProjectBindings } from "../../src/plugin-inference";

const tempDirs: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "vite-cloud-inference-"));
  tempDirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  return root;
}

describe("inferProjectBindings", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("infers bindings from src/main.ssr.tsx", () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, "src", "main.ssr.tsx"),
      `
      export async function render(request, env) {
        await env.KV.put("k", "v");
        return new Response("ok");
      }
      `,
    );

    expect(inferProjectBindings(root)).toEqual({
      needsD1: false,
      needsKV: true,
      needsR2: false,
      needsAuth: false,
    });
  });

  it("detects auth from vite-cloud/client import with auth specifier in src/", () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, "src", "App.tsx"),
      `
      import { auth, AuthError } from "vite-cloud/client";
      export default function App() {
        auth.me();
      }
      `,
    );

    const result = inferProjectBindings(root);
    expect(result.needsAuth).toBe(true);
  });

  it("detects auth from vite-cloud/auth import in routes/", () => {
    const root = createTempRoot();
    mkdirSync(join(root, "routes", "api"), { recursive: true });
    writeFileSync(
      join(root, "routes", "api", "profile.ts"),
      `
      import { requireAuth } from "vite-cloud/auth";
      export const GET = (c) => {
        const user = requireAuth(c);
        return { user };
      };
      `,
    );

    const result = inferProjectBindings(root);
    expect(result.needsAuth).toBe(true);
  });

  it("does not detect auth from vite-cloud/client with only fetch", () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, "src", "App.tsx"),
      `
      import { fetch } from "vite-cloud/client";
      export default function App() {
        fetch("/api/hello");
      }
      `,
    );

    const result = inferProjectBindings(root);
    expect(result.needsAuth).toBe(false);
  });

  it("does not scan src/ twice in framework mode", () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, "src", "App.tsx"),
      `
      import { auth } from "vite-cloud/client";
      `,
    );

    // When scanDirs already includes "src", it should not double-scan
    const result = inferProjectBindings(root, undefined, ["src", "routes"]);
    expect(result.needsAuth).toBe(true);
  });
});
