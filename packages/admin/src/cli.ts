#!/usr/bin/env node
import { parseArgs } from "node:util";
import * as p from "@clack/prompts";
import { createClient } from "./cli/client";
import { usersCommand } from "./cli/commands/users";
import { statsCommand } from "./cli/commands/stats";

const USAGE = `Usage: vca <command> [options]

Commands:
  users list [--plan <plan>] [--limit <n>]  List users
  users get <id>                             Get user details
  users plan <id> <plan>                     Change user plan
  users suspend <id>                         Suspend user
  users unsuspend <id>                       Unsuspend user
  stats                                      System stats

Options:
  --api-url <url>     Platform API URL (default: https://api.vite.cloud)
  --help              Show this help message`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      "api-url": { type: "string", default: "https://api.vite.cloud" },
      help: { type: "boolean", default: false },
      plan: { type: "string" },
      limit: { type: "string" },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    process.exit(0);
  }

  const client = createClient(values["api-url"]!);

  const [command, subcommand, ...args] = positionals;

  switch (command) {
    case "users":
      await usersCommand(client, subcommand, args, values);
      break;
    case "stats":
      await statsCommand(client);
      break;
    default:
      p.log.error(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  p.log.error(String(err));
  process.exit(1);
});
