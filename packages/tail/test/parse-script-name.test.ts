import { describe, it, expect } from "vitest";
import { parseScriptName } from "../src/index";

describe("parseScriptName", () => {
  it("parses versioned script name", () => {
    expect(parseScriptName("user-myapp-dpl_abc123")).toEqual({
      projectKey: "user-myapp",
      deployId: "dpl_abc123",
    });
  });

  it("parses legacy script name", () => {
    expect(parseScriptName("user-myapp")).toEqual({
      projectKey: "user-myapp",
      deployId: "",
    });
  });

  it("handles hyphenated slugs with versioned name", () => {
    expect(parseScriptName("user-my-hyphenated-app-dpl_xyz789")).toEqual({
      projectKey: "user-my-hyphenated-app",
      deployId: "dpl_xyz789",
    });
  });

  it("filters out non-user scripts", () => {
    expect(parseScriptName("void-api")).toBeNull();
    expect(parseScriptName("void-dispatch")).toBeNull();
  });
});
