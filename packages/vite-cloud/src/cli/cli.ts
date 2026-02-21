#!/usr/bin/env node

import { execSync } from "node:child_process";
import { log, outro, note } from "@clack/prompts";
import { runLink } from "./link";
import { runLoginCommand } from "./login";
import { runProjectsCommand } from "./projects";
import { getToken, removeToken, isStagingMode, setStagingMode, printStagingBanner } from "./auth";
import { PlatformClient } from "./client";
import { parseDeployArgs } from "./args";
import { parseSecretArgs } from "./secret-args";
import { parseDbArgs } from "./db-args";
import { parseGenArgs } from "./gen-args";
import { parseDomainArgs } from "./domain";
import { categoryTitle, helpLine, pc, sectionTitle } from "./output";

const args = process.argv.slice(2);
const command = args[0];

printStagingBanner();

if (command === "staging") {
  const sub = args[1];
  if (sub === "on") {
    setStagingMode(true);
    log.success("Staging mode enabled.");
  } else if (sub === "off") {
    setStagingMode(false);
    log.success("Staging mode disabled.");
  } else {
    log.info(`Staging mode is ${isStagingMode() ? "on" : "off"}.`);
  }
} else if (command === "deploy") {
  const root = process.cwd();
  let deployArgs;
  try {
    deployArgs = parseDeployArgs(args.slice(1));
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  import("./deploy").then(({ runDeploy }) => {
    runDeploy(root, {
      projectSlug: deployArgs.projectSlug,
      dir: deployArgs.dir,
      spa: deployArgs.spa,
      skipBuild: deployArgs.skipBuild,
    }).catch((err) => {
      log.error(err.message ?? err);
      process.exit(1);
    });
  });
} else if (command === "link") {
  const root = process.cwd();
  const slug = args[1];
  runLink(root, slug).catch((err) => {
    log.error(err.message ?? err);
    process.exit(1);
  });
} else if (command === "login") {
  runLoginCommand().catch((err) => {
    log.error(err.message ?? err);
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
    log.error("Not logged in. Run `vcc login` first.");
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
} else if (command === "list" || command === "ls") {
  const root = process.cwd();
  import("./list").then(({ runListCommand }) => {
    runListCommand(root, args[1]).catch((err) => {
      log.error(err.message ?? err);
      process.exit(1);
    });
  });
} else if (command === "projects") {
  runProjectsCommand().catch((err) => {
    log.error(err.message ?? err);
    process.exit(1);
  });
} else if (command === "secret") {
  const root = process.cwd();
  let secretArgs;
  try {
    secretArgs = parseSecretArgs(args.slice(1));
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  import("./secret").then(({ runSecretCommand }) => {
    runSecretCommand(root, secretArgs).catch((err) => {
      log.error(err.message ?? err);
      process.exit(1);
    });
  });
} else if (command === "token") {
  (async () => {
    if (!getToken()) {
      await runLoginCommand();
    }
    const token = getToken();
    if (!token) {
      log.error("Login failed. Run `vcc login` to try again.");
      process.exit(1);
    }
    const platform = process.platform;
    const cmd =
      platform === "darwin"
        ? "pbcopy"
        : platform === "win32"
          ? "clip"
          : "xclip -selection clipboard";
    try {
      execSync(cmd, { input: token });
      log.success("Token copied to clipboard.");
    } catch {
      log.warn(
        "Could not copy to clipboard. Copy the token manually from ~/.vite-cloud/config.json",
      );
    }
  })().catch((err) => {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else if (command === "delete") {
  const root = process.cwd();
  import("./delete").then(({ runDeleteCommand }) => {
    runDeleteCommand(root, args[1]).catch((err) => {
      log.error(err.message ?? err);
      process.exit(1);
    });
  });
} else if (command === "domain") {
  const root = process.cwd();
  let domainArgs;
  try {
    domainArgs = parseDomainArgs(args.slice(1));
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  import("./domain").then(({ runDomainCommand }) => {
    runDomainCommand(root, domainArgs!).catch((err) => {
      log.error(err.message ?? err);
      process.exit(1);
    });
  });
} else if (command === "db") {
  const root = process.cwd();
  let dbArgs;
  try {
    dbArgs = parseDbArgs(args.slice(1));
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  import("./db").then(({ runDbCommand }) => {
    runDbCommand(root, dbArgs!).catch((err) => {
      log.error(err.message ?? err);
      process.exit(1);
    });
  });
} else if (command === "gen") {
  const root = process.cwd();
  let genArgs;
  try {
    genArgs = parseGenArgs(args.slice(1));
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  import("./gen").then(({ runGenCommand }) => {
    runGenCommand(root, genArgs!).catch((err) => {
      log.error(err.message ?? err);
      process.exit(1);
    });
  });
} else if (command === "init") {
  const root = process.cwd();
  import("./init").then(({ runInitCommand, parseInitArgs }) => {
    let initArgs;
    try {
      initArgs = parseInitArgs(args.slice(1));
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    runInitCommand(root, initArgs).catch((err) => {
      log.error(err.message ?? err);
      process.exit(1);
    });
  });
} else if (command === "mcp") {
  import("./mcp").then(({ runMcp }) => {
    runMcp();
  });
} else {
  console.log(
    pc.blue(`
        _ __                __                __
 _   __(_) /____     _____/ /___  __  ______/ /
| | / / / __/ _ \\   / ___/ / __ \\/ / / / __  /
| |/ / / /_/  __/  / /__/ / /_/ / /_/ / /_/ /
|___/_/\\__/\\___/   \\___/_/\\____/\\__,_/\\__,_/
`),
  );

  if (command && command !== "help" && command !== "--help" && command !== "-h") {
    log.error(`Unknown command: ${command}`);
    process.exit(1);
  }

  note(
    [
      helpLine("vcc init", "Set up vite-cloud in an existing project"),
      helpLine("  --tsconfig", "Only update tsconfig.json"),
      helpLine("  --github", "Only create GitHub Actions workflow"),
      helpLine("  --agentsmd", "Only add coding agent instructions"),
      "",
      helpLine("vcc deploy", "Build and deploy to Vite Cloud"),
      helpLine("  --project <name>", "Deploy target project name"),
      helpLine("  --dir <path>", "Deploy a static directory (skip build)"),
      helpLine("  --spa", "Use SPA mode (default: SSG)"),
      helpLine("  --skip-build", "Skip the build step (use existing output)"),
      "",
      categoryTitle("auth"),
      helpLine("vcc login", "Log in with GitHub or Google"),
      helpLine("vcc logout", "Log out and remove credentials"),
      helpLine("vcc whoami", "Show the logged-in username"),
      helpLine("vcc token", "Copy auth token to clipboard"),
      "",
      categoryTitle("projects"),
      helpLine("vcc projects", "List your projects"),
      helpLine("vcc list, ls [name]", "List deployments for a project"),
      helpLine("vcc delete [name]", "Delete a project and all its resources"),
      helpLine("vcc link [name]", "Link to an existing project"),
      "",
      categoryTitle("secrets"),
      helpLine("vcc secret put <name> [--project]", "Set a project secret"),
      helpLine("vcc secret delete <name>", "Delete a project secret"),
      helpLine("vcc secret sync <file>", "Sync secrets from a dotenv file"),
      "",
      categoryTitle("domains"),
      helpLine("vcc domain add <hostname>", "Add a custom domain"),
      helpLine("vcc domain remove <hostname>", "Remove a custom domain"),
      helpLine("vcc domain list", "List custom domains + status"),
      helpLine("vcc domain status <hostname>", "Check domain verification status"),
      "",
      categoryTitle("database"),
      helpLine("vcc db status", "Show migration status (local + remote)"),
      helpLine("vcc db reset", "Reset local DB and re-run migrations"),
      helpLine("vcc db seed [--file <path>]", "Reset local DB, run migrations, and seed"),
      helpLine("vcc db execute <sql>", "Run SQL against the local database"),
      helpLine("  --file <path>", "Run SQL from a file instead"),
      helpLine("vcc db migrate", "Apply pending migrations locally"),
      helpLine("vcc db export [--output <path>]", "Export local database as SQL"),
      helpLine("  --no-data", "Schema only (no INSERT statements)"),
      helpLine("  --no-schema", "Data only (no CREATE TABLE)"),
      helpLine("  --table <name>", "Export a single table"),
      "",
      categoryTitle("codegen"),
      helpLine("vcc gen model <name> [cols...]", "Generate migration + CRUD routes + db types"),
      helpLine("vcc gen migration <name>", "Generate an empty migration file"),
      helpLine("vcc gen route <path> [--methods]", "Generate a route with handler exports"),
      helpLine("vcc gen middleware <name>", "Generate a numbered middleware file"),
      helpLine("vcc gen ssr [--react|--vue|...]", "Generate SSR entry + client + App component"),
      helpLine("vcc gen cron <name>", "Generate a cron job file"),
      helpLine("vcc gen queue <name>", "Generate a queue consumer file"),
      "",
      categoryTitle("agent"),
      helpLine("vcc init --agentsmd", "Inject agent instructions into CLAUDE.md/AGENTS.md"),
      helpLine("vcc init --skills", "Link vite-cloud skills to your agent"),
      helpLine("vcc init --prompt", "Print the coding agent reference prompt"),
      helpLine("vcc mcp", "Start MCP server (stdio, for AI agents)"),
    ].join("\n"),
    sectionTitle("Commands"),
  );

  note(
    [
      helpLine("VITE_CLOUD_TOKEN", "Auth token (or use ~/.vite-cloud/config.json)"),
      helpLine("VITE_CLOUD_PROJECT", "Deploy target project name override"),
    ].join("\n"),
    sectionTitle("Environment"),
  );

  outro("https://vite.cloud");
}
