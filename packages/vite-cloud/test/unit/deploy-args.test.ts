import { describe, expect, it } from "vitest";
import { parseDeployArgs } from "../../src/cli/args";

describe("parseDeployArgs", () => {
  it("parses --project slug", () => {
    expect(parseDeployArgs(["--project", "my-app"])).toEqual({ projectSlug: "my-app" });
  });

  it("returns empty args when no options are provided", () => {
    expect(parseDeployArgs([])).toEqual({ projectSlug: undefined });
  });

  it("throws when --project has no value", () => {
    expect(() => parseDeployArgs(["--project"])).toThrow("Error: --project requires a slug");
  });

  it("throws when --project value looks like another flag", () => {
    expect(() => parseDeployArgs(["--project", "--foo"])).toThrow(
      "Error: --project requires a slug",
    );
  });

  it("throws for duplicate --project flags", () => {
    expect(() => parseDeployArgs(["--project", "a", "--project", "b"])).toThrow(
      "Error: --project can only be specified once",
    );
  });

  it("throws for unknown options", () => {
    expect(() => parseDeployArgs(["--foo"])).toThrow("Error: Unknown option for deploy: --foo");
  });

  it("throws for unexpected positional arguments", () => {
    expect(() => parseDeployArgs(["my-app"])).toThrow(
      "Error: Unexpected argument for deploy: my-app",
    );
  });
});
