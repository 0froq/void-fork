#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { detectPM, pmExec, pmInstall, run } from "./pm";

const pm = detectPM();

async function getLatestVersion(pkg: string): Promise<string> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`);
    const data = (await res.json()) as { version?: string };
    if (data.version) return `^${data.version}`;
  } catch {}
  return "latest";
}

async function main() {
  console.log();
  p.intro(pc.bgCyan(pc.black(" create-void ")));

  // 1. Get app name from argv or prompt
  let appName = process.argv[2];

  if (!appName) {
    const name = await p.text({
      message: "Project name:",
      placeholder: "my-app",
      validate(value) {
        if (!value?.trim()) return "Project name is required";
      },
    });
    if (p.isCancel(name)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    appName = name;
  }

  // 2. Validate target dir
  const targetDir = resolve(appName);

  if (existsSync(targetDir)) {
    const entries = readdirSync(targetDir);
    if (entries.length > 0) {
      p.log.error(`Directory ${pc.bold(appName)} is not empty.`);
      process.exit(1);
    }
  }

  // 3. Resolve latest versions in parallel
  const [voidVersion, viteVersion, honoVersion, tsVersion] = await Promise.all([
    getLatestVersion("void"),
    getLatestVersion("vite"),
    getLatestVersion("hono"),
    getLatestVersion("typescript"),
  ]);

  // 4. Scaffold: create dir, write package.json, install, void init
  mkdirSync(targetDir, { recursive: true });

  const pkg = {
    name: appName,
    private: true,
    type: "module",
    scripts: {
      dev: "vite",
      build: "vite build",
      preview: "vite preview",
    },
    dependencies: {
      void: voidVersion,
      vite: viteVersion,
      hono: honoVersion,
      typescript: tsVersion,
    },
  };

  writeFileSync(resolve(targetDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  p.log.step("Installing dependencies...");
  await run([...pmInstall(pm)], targetDir);

  await run([...pmExec(pm), "void", "init"], targetDir);

  p.log.success(`Created ${pc.bold(appName)}`);
  p.outro(`cd ${appName} && ${pm === "npm" ? "npm run" : pm} dev`);
}

main().catch((err) => {
  p.log.error(err.message);
  process.exit(1);
});
