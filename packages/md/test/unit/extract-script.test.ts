import { describe, expect, it } from "vitest";
import { extractScript } from "../../src/extract-script";

describe("extractScript", () => {
  it("returns null script when no <script> block", () => {
    const result = extractScript("# Hello\n\nWorld");
    expect(result.script).toBeNull();
    expect(result.body).toBe("# Hello\n\nWorld");
    expect(result.islandImports).toEqual([]);
  });

  it("extracts <script> block and returns body without it", () => {
    const source = `<script>
import Foo from "./Foo.vue" with { island: "load" }
</script>

# Hello`;
    const result = extractScript(source);
    expect(result.script).toBe('import Foo from "./Foo.vue" with { island: "load" }');
    expect(result.body.trim()).toBe("# Hello");
  });

  it("parses island imports with correct name/specifier/strategy", () => {
    const source = `<script>
import Counter from "../components/Counter.vue" with { island: "visible" }
import CodePlayground from "../components/CodePlayground.vue" with { island: "idle" }
</script>

# Page`;
    const result = extractScript(source);
    expect(result.islandImports).toHaveLength(2);
    expect(result.islandImports[0]).toEqual({
      name: "Counter",
      specifier: "../components/Counter.vue",
      strategy: "visible",
    });
    expect(result.islandImports[1]).toEqual({
      name: "CodePlayground",
      specifier: "../components/CodePlayground.vue",
      strategy: "idle",
    });
  });

  it("handles single-quoted imports", () => {
    const source = `<script>
import Widget from './Widget.vue' with { island: 'load' }
</script>

# Page`;
    const result = extractScript(source);
    expect(result.islandImports).toHaveLength(1);
    expect(result.islandImports[0]).toEqual({
      name: "Widget",
      specifier: "./Widget.vue",
      strategy: "load",
    });
  });

  it("handles <script> before frontmatter", () => {
    const source = `<script>
import A from "./A.vue" with { island: "load" }
</script>

---
title: Test
---

# Hello`;
    const result = extractScript(source);
    expect(result.script).toContain("import A");
    expect(result.body).toContain("---");
    expect(result.body).toContain("# Hello");
  });

  it("handles media strategy", () => {
    const source = `<script>
import Sidebar from "./Sidebar.vue" with { island: "media:(min-width: 768px)" }
</script>

# Page`;
    const result = extractScript(source);
    expect(result.islandImports[0].strategy).toBe("media:(min-width: 768px)");
  });
});
