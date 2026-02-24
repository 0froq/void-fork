import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptsDir, "..");
const sourceDir = resolve(packageDir, "../../docs");
const targetDir = resolve(packageDir, "skills/void/docs");

if (!existsSync(sourceDir)) {
  throw new Error(`Missing docs source directory: ${sourceDir}`);
}

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });

for (const file of readdirSync(sourceDir)) {
  if (file.endsWith(".md")) {
    cpSync(resolve(sourceDir, file), resolve(targetDir, file));
  }
}
