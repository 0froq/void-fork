import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptsDir, "..");
const sourceDir = resolve(packageDir, "../website/docs");
const targetDir = resolve(packageDir, "skills/vite-cloud/docs");

if (!existsSync(sourceDir)) {
  throw new Error(`Missing docs source directory: ${sourceDir}`);
}

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(resolve(targetDir, ".."), { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });
