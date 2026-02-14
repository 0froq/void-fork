#!/usr/bin/env node

import { runDeploy } from "./deploy";
import { runLink } from "./link";
import { runLoginCommand } from "./login";

const args = process.argv.slice(2);
const command = args[0];

if (command === "deploy") {
  const root = process.cwd();
  runDeploy(root).catch((err) => {
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
} else {
  console.log(`vite-cloud CLI (alias: vcd)

Usage:
  vcd login          Log in with GitHub
  vcd deploy         Build and deploy to Vite Cloud
  vcd link [slug]    Link to an existing project

Environment:
  VITE_CLOUD_TOKEN     Auth token (or use ~/.vite-cloud/credentials.json)
  VITE_CLOUD_API_URL   Platform API URL (default: https://api.vite.cloud)
`);
  if (command && command !== "help" && command !== "--help" && command !== "-h") {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}
