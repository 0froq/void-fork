import { parseArgs } from "node:util";

export type DbArgs = { action: "status" } | { action: "reset" } | { action: "seed"; file?: string };

export function parseDbArgs(args: string[]): DbArgs {
  const parsed = parseArgs({
    args,
    options: {
      file: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });

  const [action, extra] = parsed.positionals;
  if (extra) {
    throw new Error(`Error: Unexpected argument: ${extra}`);
  }

  if (action === "status") {
    return { action };
  }

  if (action === "reset") {
    return { action };
  }

  if (action === "seed") {
    const file = typeof parsed.values.file === "string" ? parsed.values.file : undefined;
    return { action, file };
  }

  throw new Error("Error: Usage: vcd db <status|reset|seed>");
}
