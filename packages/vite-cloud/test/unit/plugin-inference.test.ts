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
    });
  });
});
