import type { SubcommandDef } from "./subcommand-prompt";

export const projectSubcommands: SubcommandDef[] = [
  { name: "list", description: "List your projects" },
  { name: "rm", arg: "<name>", description: "Delete a project and all its resources" },
];

export type ProjectArgs = { subcommand: "list" } | { subcommand: "rm"; name: string };

export function parseProjectArgs(args: string[]): ProjectArgs {
  const [subcommand, ...rest] = args;

  if (subcommand === "list") {
    if (rest.length > 0) {
      throw new Error(`Error: Unexpected argument: ${rest[0]}`);
    }
    return { subcommand };
  }

  if (subcommand === "rm") {
    const [name, extra] = rest;
    if (extra) {
      throw new Error(`Error: Unexpected argument: ${extra}`);
    }
    return { subcommand, name: name ?? "" };
  }

  throw new Error("Error: Usage: void project <list|rm>");
}
