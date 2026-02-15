#!/usr/bin/env node

import { log, outro, note } from "@clack/prompts";
import { runDeploy } from "./deploy";
import { runLink } from "./link";
import { runLoginCommand } from "./login";
import { runListCommand } from "./list";
import { runSecretCommand } from "./secret";
import { runDeleteCommand } from "./delete";
import { getToken, removeToken } from "./auth";
import { PlatformClient } from "./client";
import { parseDeployArgs } from "./args";
import { parseSecretArgs } from "./secret-args";

const args = process.argv.slice(2);
const command = args[0];

if (command === "deploy") {
  const root = process.cwd();
  let deployArgs;
  try {
    deployArgs = parseDeployArgs(args.slice(1));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  runDeploy(root, { projectSlug: deployArgs.projectSlug }).catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
} else if (command === "link") {
  const root = process.cwd();
  const slug = args[1];
  runLink(root, slug).catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
} else if (command === "login") {
  runLoginCommand().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
} else if (command === "logout") {
  if (removeToken()) {
    log.success("Logged out.");
  } else {
    log.info("Not logged in.");
  }
} else if (command === "whoami") {
  const token = getToken();
  if (!token) {
    log.error("Not logged in. Run `vcd login` first.");
    process.exit(1);
  }
  const client = new PlatformClient(token);
  client
    .whoami()
    .then((user) => {
      log.info(user.login);
    })
    .catch((err) => {
      log.error(err.message ?? err);
      process.exit(1);
    });
} else if (command === "list") {
  runListCommand().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
} else if (command === "secret") {
  const root = process.cwd();
  let secretArgs;
  try {
    secretArgs = parseSecretArgs(args.slice(1));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  runSecretCommand(root, secretArgs).catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
} else if (command === "delete") {
  const root = process.cwd();
  runDeleteCommand(root, args[1]).catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
} else {
  const BLUE = "\x1b[34m";
  const RESET = "\x1b[0m";
  console.log(
    BLUE +
      `
        _ __                __                __
 _   __(_) /____     _____/ /___  __  ______/ /
| | / / / __/ _ \\   / ___/ / __ \\/ / / / __  /
| |/ / / /_/  __/  / /__/ / /_/ / /_/ / /_/ /
|___/_/\\__/\\___/   \\___/_/\\____/\\__,_/\\__,_/
` +
      RESET,
  );

  if (command && command !== "help" && command !== "--help" && command !== "-h") {
    log.error(`Unknown command: ${command}`);
    process.exit(1);
  }

  note(
    [
      "vcd login                          Log in with GitHub or Google",
      "vcd logout                         Log out and remove credentials",
      "vcd whoami                         Show the logged-in username",
      "vcd list                           List your projects",
      "vcd deploy [--project <name>]      Build and deploy to Vite Cloud",
      "vcd delete [name]                  Delete a project and all its resources",
      "vcd link [name]                    Link to an existing project",
      "vcd secret put <name> [--project]  Set a project secret",
      "vcd secret delete <name>           Delete a project secret",
    ].join("\n"),
    "Commands",
  );

  note(
    [
      "VITE_CLOUD_TOKEN     Auth token (or use ~/.vite-cloud/credentials.json)",
      "VITE_CLOUD_PROJECT   Deploy target project name override",
    ].join("\n"),
    "Environment",
  );

  outro("https://vite.cloud");
}
