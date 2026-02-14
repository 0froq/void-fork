#!/usr/bin/env node

import { runDeploy } from "./deploy";

const args = process.argv.slice(2);
const command = args[0];

if (command === "deploy") {
  const root = process.cwd();
  runDeploy(root).catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
} else {
  console.log(`vite-cloud CLI

Usage:
  vite-cloud deploy    Build and deploy to Vite Cloud

Environment:
  VITE_CLOUD_TOKEN     Auth token (or use ~/.vite-cloud/credentials.json)
  VITE_CLOUD_API_URL   Platform API URL (default: https://vite-cloud-platform.workers.dev)
`);
  if (command && command !== "help" && command !== "--help" && command !== "-h") {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}
