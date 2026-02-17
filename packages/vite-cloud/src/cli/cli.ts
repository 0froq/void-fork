#!/usr/bin/env node

import { execSync } from "node:child_process";
import { log, outro, note } from "@clack/prompts";
import { runDeploy } from "./deploy";
import { runLink } from "./link";
import { runLoginCommand } from "./login";
import { runListCommand } from "./list";
import { runProjectsCommand } from "./projects";
import { runSecretCommand } from "./secret";
import { runDeleteCommand } from "./delete";
import { getToken, removeToken } from "./auth";
import { PlatformClient } from "./client";
import { parseDeployArgs } from "./args";
import { parseSecretArgs } from "./secret-args";
import { parseDbArgs } from "./db-args";

const args = process.argv.slice(2);
const command = args[0];

if (command === "deploy") {
  const root = process.cwd();
  let deployArgs;
  try {
    deployArgs = parseDeployArgs(args.slice(1));
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  runDeploy(root, {
    projectSlug: deployArgs.projectSlug,
    dir: deployArgs.dir,
    spa: deployArgs.spa,
  }).catch((err) => {
    log.error(err.message ?? err);
    process.exit(1);
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
} else if (command === "list" || command === "ls") {
  const root = process.cwd();
  runListCommand(root, args[1]).catch((err) => {
    log.error(err.message ?? err);
    process.exit(1);
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

  runSecretCommand(root, secretArgs).catch((err) => {
    log.error(err.message ?? err);
    process.exit(1);
  });
} else if (command === "token") {
  (async () => {
    if (!getToken()) {
      await runLoginCommand();
    }
    const token = getToken();
    if (!token) {
      log.error("Login failed. Run `vcd login` to try again.");
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
        "Could not copy to clipboard. Copy the token manually from ~/.vite-cloud/credentials.json",
      );
    }
  })().catch((err) => {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else if (command === "delete") {
  const root = process.cwd();
  runDeleteCommand(root, args[1]).catch((err) => {
    log.error(err.message ?? err);
    process.exit(1);
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
      "\x1b[0mvcd login                          \x1b[2mLog in with GitHub or Google",
      "\x1b[0mvcd logout                         \x1b[2mLog out and remove credentials",
      "\x1b[0mvcd whoami                         \x1b[2mShow the logged-in username",
      "\x1b[0mvcd token                          \x1b[2mCopy auth token to clipboard",
      "\x1b[0mvcd projects                       \x1b[2mList your projects",
      "\x1b[0mvcd list, ls [name]                \x1b[2mList deployments for a project",
      "\x1b[0mvcd deploy [--project <name>]      \x1b[2mBuild and deploy to Vite Cloud",
      "\x1b[0m  --dir <path>                    \x1b[2mDeploy a static directory (skip build)",
      "\x1b[0m  --spa                           \x1b[2mUse SPA mode (default: SSG)",
      "\x1b[0mvcd delete [name]                  \x1b[2mDelete a project and all its resources",
      "\x1b[0mvcd link [name]                    \x1b[2mLink to an existing project",
      "\x1b[0mvcd secret put <name> [--project]  \x1b[2mSet a project secret",
      "\x1b[0mvcd secret delete <name>           \x1b[2mDelete a project secret",
      "\x1b[0mvcd db status                      \x1b[2mShow migration status (local + remote)",
      "\x1b[0mvcd db reset                       \x1b[2mReset local DB and re-run migrations",
      "\x1b[0mvcd db seed [--file <path>]        \x1b[2mReset local DB, run migrations, and seed",
    ].join("\n"),
    "\x1b[34mCommands\x1b[0m",
  );

  note(
    [
      "\x1b[0mVITE_CLOUD_TOKEN     \x1b[2mAuth token (or use ~/.vite-cloud/credentials.json)",
      "\x1b[0mVITE_CLOUD_PROJECT   \x1b[2mDeploy target project name override",
    ].join("\n"),
    "\x1b[34mEnvironment\x1b[0m",
  );

  outro("https://vite.cloud");
}
