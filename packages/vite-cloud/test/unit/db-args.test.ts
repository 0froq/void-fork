import { describe, expect, it } from "vitest";
import { parseDbArgs } from "../../src/cli/db-args";

describe("parseDbArgs", () => {
  it("parses status", () => {
    expect(parseDbArgs(["status"])).toEqual({ action: "status" });
  });

  it("parses reset", () => {
    expect(parseDbArgs(["reset"])).toEqual({ action: "reset" });
  });

  it("parses seed", () => {
    expect(parseDbArgs(["seed"])).toEqual({ action: "seed", file: undefined });
  });

  it("parses seed with --file", () => {
    expect(parseDbArgs(["seed", "--file", "custom.sql"])).toEqual({
      action: "seed",
      file: "custom.sql",
    });
  });

  it("errors on unknown subcommand", () => {
    expect(() => parseDbArgs(["migrate"])).toThrow("Error: Usage: vcd db <status|reset|seed>");
  });

  it("errors on no subcommand", () => {
    expect(() => parseDbArgs([])).toThrow("Error: Usage: vcd db <status|reset|seed>");
  });

  it("errors on extra positional", () => {
    expect(() => parseDbArgs(["status", "extra"])).toThrow("Error: Unexpected argument: extra");
  });
});
