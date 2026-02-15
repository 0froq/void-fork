#!/usr/bin/env node

import { runDeploy } from "./deploy";
import { runLink } from "./link";
import { runLoginCommand } from "./login";
import { runListCommand } from "./list";
import { runSecretCommand } from "./secret";
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
    console.log("Logged out.");
  } else {
    console.log("Not logged in.");
  }
} else if (command === "whoami") {
  const token = getToken();
  if (!token) {
    console.error("Not logged in. Run `vcd login` first.");
    process.exit(1);
  }
  const client = new PlatformClient(token);
  client
    .whoami()
    .then((user) => {
      console.log(user.login);
    })
    .catch((err) => {
      console.error(err.message ?? err);
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
} else {
  console.log(`vite-cloud CLI (alias: vcd)

Usage:
  vcd login          Log in with GitHub
  vcd logout         Log out and remove credentials
  vcd whoami         Show the logged-in GitHub username
  vcd list           List your projects
  vcd secret put <name> [--project <name>]
                     Set a project secret (value from prompt or stdin)
  vcd secret delete <name> [--project <name>]
                     Delete a project secret
  vcd deploy [--project <name>]
                     Build and deploy to Vite Cloud
  vcd link [name]    Link to an existing project

Environment:
  VITE_CLOUD_TOKEN     Auth token (or use ~/.vite-cloud/credentials.json)
  VITE_CLOUD_PROJECT   Deploy target project name override
`);
  if (command && command !== "help" && command !== "--help" && command !== "-h") {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}
