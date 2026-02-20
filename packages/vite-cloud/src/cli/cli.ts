#!/usr/bin/env node

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
} else if (command === "agent-prompt") {
  let dir = join(fileURLToPath(import.meta.url), "..");
  for (let i = 0; i < 5; i++) {
    const promptPath = join(dir, "getting-started-prompt.txt");
    if (existsSync(promptPath)) {
      process.stdout.write(readFileSync(promptPath, "utf-8"));
      break;
    }
    dir = join(dir, "..");
  }
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
      "\x1b[0mvcc init                           \x1b[2mSet up vite-cloud in an existing project",
      "\x1b[0m  --tsconfig                       \x1b[2mOnly update tsconfig.json",
      "\x1b[0m  --github                         \x1b[2mOnly create GitHub Actions workflow",
      "\x1b[0m  --agent                          \x1b[2mOnly add coding agent instructions",
      "",
      "\x1b[0mvcc deploy                         \x1b[2mBuild and deploy to Vite Cloud",
      "\x1b[0m  --project <name>                 \x1b[2mDeploy target project name",
      "\x1b[0m  --dir <path>                     \x1b[2mDeploy a static directory (skip build)",
      "\x1b[0m  --spa                            \x1b[2mUse SPA mode (default: SSG)",
      "\x1b[0m  --skip-build                     \x1b[2mSkip the build step (use existing output)",
      "",
      "\x1b[0m\x1b[1m\x1b[36mauth\x1b[39m",
      "\x1b[0mvcc login                          \x1b[2mLog in with GitHub or Google",
      "\x1b[0mvcc logout                         \x1b[2mLog out and remove credentials",
      "\x1b[0mvcc whoami                         \x1b[2mShow the logged-in username",
      "\x1b[0mvcc token                          \x1b[2mCopy auth token to clipboard",
      "",
      "\x1b[0m\x1b[1m\x1b[36mprojects\x1b[39m",
      "\x1b[0mvcc projects                       \x1b[2mList your projects",
      "\x1b[0mvcc list, ls [name]                \x1b[2mList deployments for a project",
      "\x1b[0mvcc delete [name]                  \x1b[2mDelete a project and all its resources",
      "\x1b[0mvcc link [name]                    \x1b[2mLink to an existing project",
      "",
      "\x1b[0m\x1b[1m\x1b[36msecrets\x1b[39m",
      "\x1b[0mvcc secret put <name> [--project]  \x1b[2mSet a project secret",
      "\x1b[0mvcc secret delete <name>           \x1b[2mDelete a project secret",
      "\x1b[0mvcc secret sync <file>             \x1b[2mSync secrets from a dotenv file",
      "",
      "\x1b[0m\x1b[1m\x1b[36mdomains\x1b[39m",
      "\x1b[0mvcc domain add <hostname>          \x1b[2mAdd a custom domain",
      "\x1b[0mvcc domain remove <hostname>       \x1b[2mRemove a custom domain",
      "\x1b[0mvcc domain list                    \x1b[2mList custom domains + status",
      "\x1b[0mvcc domain status <hostname>       \x1b[2mCheck domain verification status",
      "",
      "\x1b[0m\x1b[1m\x1b[36mdatabase\x1b[39m",
      "\x1b[0mvcc db status                      \x1b[2mShow migration status (local + remote)",
      "\x1b[0mvcc db reset                       \x1b[2mReset local DB and re-run migrations",
      "\x1b[0mvcc db seed [--file <path>]        \x1b[2mReset local DB, run migrations, and seed",
      "\x1b[0mvcc db execute <sql>               \x1b[2mRun SQL against the local database",
      "\x1b[0m  --file <path>                    \x1b[2mRun SQL from a file instead",
      "\x1b[0mvcc db migrate                     \x1b[2mApply pending migrations locally",
      "\x1b[0mvcc db export [--output <path>]    \x1b[2mExport local database as SQL",
      "\x1b[0m  --no-data                        \x1b[2mSchema only (no INSERT statements)",
      "\x1b[0m  --no-schema                      \x1b[2mData only (no CREATE TABLE)",
      "\x1b[0m  --table <name>                   \x1b[2mExport a single table",
      "",
      "\x1b[0m\x1b[1m\x1b[36mscaffolding\x1b[39m",
      "\x1b[0mvcc gen model <name> [cols...]     \x1b[2mGenerate migration + CRUD routes + db types",
      "\x1b[0mvcc gen migration <name>           \x1b[2mGenerate an empty migration file",
      "\x1b[0mvcc gen route <path> [--methods]   \x1b[2mGenerate a route with handler exports",
      "\x1b[0mvcc gen middleware <name>          \x1b[2mGenerate a numbered middleware file",
      "\x1b[0mvcc gen ssr [--react|--vue|...]    \x1b[2mGenerate SSR entry + client + App component",
      "\x1b[0mvcc gen cron <name>               \x1b[2mGenerate a cron job file",
      "\x1b[0mvcc gen queue <name>              \x1b[2mGenerate a queue consumer file",
      "",
      "\x1b[0m\x1b[1m\x1b[36magent\x1b[39m",
      "\x1b[0mvcc init --agent                   \x1b[2mInject agent instructions into CLAUDE.md/AGENTS.md",
      "\x1b[0mvcc init --skills                  \x1b[2mLink vite-cloud skills to your agent",
      "\x1b[0mvcc agent-prompt                   \x1b[2mPrint the coding agent reference prompt",
      "\x1b[0mvcc mcp                            \x1b[2mStart MCP server (stdio, for AI agents)",
    ].join("\n"),
    "\x1b[34mCommands\x1b[0m",
  );

  note(
    [
      "\x1b[0mVITE_CLOUD_TOKEN     \x1b[2mAuth token (or use ~/.vite-cloud/config.json)",
      "\x1b[0mVITE_CLOUD_PROJECT   \x1b[2mDeploy target project name override",
    ].join("\n"),
    "\x1b[34mEnvironment\x1b[0m",
  );

  outro("https://vite.cloud");
}
