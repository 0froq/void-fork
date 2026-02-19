import { parseArgs } from "node:util";

export type DbArgs =
  | { action: "status" }
  | { action: "reset" }
  | { action: "seed"; file?: string }
  | { action: "execute"; command?: string; file?: string }
  | { action: "migrate" }
  | { action: "export"; output?: string; noData?: boolean; noSchema?: boolean; table?: string };

export function parseDbArgs(args: string[]): DbArgs {
  const parsed = parseArgs({
    args,
    options: {
      file: { type: "string" },
      output: { type: "string" },
      "no-data": { type: "boolean" },
      "no-schema": { type: "boolean" },
      table: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });

  const [action, ...rest] = parsed.positionals;

  if (action === "status") {
    if (rest.length > 0) {
      throw new Error(`Error: Unexpected argument: ${rest[0]}`);
    }
    return { action };
  }

  if (action === "reset") {
    if (rest.length > 0) {
      throw new Error(`Error: Unexpected argument: ${rest[0]}`);
    }
    return { action };
  }

  if (action === "seed") {
    if (rest.length > 0) {
      throw new Error(`Error: Unexpected argument: ${rest[0]}`);
    }
    const file = typeof parsed.values.file === "string" ? parsed.values.file : undefined;
    return { action, file };
  }

  if (action === "execute") {
    const command = rest[0];
    if (rest.length > 1) {
      throw new Error(`Error: Unexpected argument: ${rest[1]}`);
    }
    const file = typeof parsed.values.file === "string" ? parsed.values.file : undefined;
    if (!command && !file) {
      throw new Error("Error: Usage: vcd db execute <sql> or vcd db execute --file <path>");
    }
    if (command && file) {
      throw new Error("Error: Provide either SQL inline or --file, not both");
    }
    return { action, command, file };
  }

  if (action === "migrate") {
    if (rest.length > 0) {
      throw new Error(`Error: Unexpected argument: ${rest[0]}`);
    }
    return { action };
  }

  if (action === "export") {
    if (rest.length > 0) {
      throw new Error(`Error: Unexpected argument: ${rest[0]}`);
    }
    const output = typeof parsed.values.output === "string" ? parsed.values.output : undefined;
    const noData = parsed.values["no-data"] === true ? true : undefined;
    const noSchema = parsed.values["no-schema"] === true ? true : undefined;
    const table = typeof parsed.values.table === "string" ? parsed.values.table : undefined;
    return { action, output, noData, noSchema, table };
  }

  throw new Error("Error: Usage: vcd db <status|reset|seed|execute|migrate|export>");
}
