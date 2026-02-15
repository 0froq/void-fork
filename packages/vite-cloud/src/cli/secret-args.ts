import { parseArgs } from "node:util";

export type SecretArgs =
  | { action: "put"; name: string; projectName?: string }
  | { action: "delete"; name: string; projectName?: string };

export function parseSecretArgs(args: string[]): SecretArgs {
  const parsed = parseArgs({
    args,
    options: {
      project: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
    tokens: true,
  });

  const tokens = parsed.tokens ?? [];
  const projectTokens = tokens.filter((t) => t.kind === "option" && t.name === "project");
  if (projectTokens.length > 1) {
    throw new Error("Error: --project can only be specified once");
  }

  const projectValue = parsed.values.project;
  const projectName = typeof projectValue === "string" ? projectValue : undefined;
  if (projectName?.startsWith("-")) {
    throw new Error("Error: --project requires a name");
  }

  const [action, name, value, extra] = parsed.positionals;
  if (extra) {
    throw new Error(`Error: Unexpected argument for secret: ${extra}`);
  }

  if (action === "put") {
    if (!name) {
      throw new Error("Error: Usage: vcd secret put <name> [--project <name>]");
    }
    if (value) {
      throw new Error("Error: Usage: vcd secret put <name> [--project <name>]");
    }
    return { action, name, projectName };
  }

  if (action === "delete") {
    if (!name) {
      throw new Error("Error: Usage: vcd secret delete <name> [--project <name>]");
    }
    if (value) {
      throw new Error("Error: Usage: vcd secret delete <name> [--project <name>]");
    }
    return { action, name, projectName };
  }

  throw new Error("Error: Usage: vcd secret <put|delete> ...");
}
