import { intro, outro, text, select, isCancel, cancel, spinner, log } from "@clack/prompts";
import { execSync, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

function detectPackageManagers(): string[] {
  const managers = ["pnpm", "yarn", "bun", "npm", "vp"];
  return managers.filter((pm) => {
    try {
      execFileSync(pm, ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
}

async function main() {
  console.log();
  intro("create-vite-cloud");

  const projectName = await text({
    message: "Project name:",
    placeholder: "my-app",
    defaultValue: "my-app",
    validate(value) {
      if (!value) return "Project name is required";
      if (!/^[a-z0-9-]+$/.test(value))
        return "Project name must be lowercase alphanumeric with dashes";
    },
  });

  if (isCancel(projectName)) {
    cancel("Operation cancelled.");
    process.exit(0);
  }

  const targetDir = resolve(process.cwd(), projectName as string);

  // Copy template
  const templateDir = join(__dirname, "..", "template");
  mkdirSync(targetDir, { recursive: true });
  cpSync(templateDir, targetDir, { recursive: true });

  // Update package.json with project name
  const pkgPath = join(targetDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  pkg.name = projectName;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  // Detect package managers and install
  const availablePMs = detectPackageManagers();
  let pm = "npm";

  if (availablePMs.length > 1) {
    const pmChoice = await select({
      message: "Which package manager?",
      options: availablePMs.map((name) => ({ value: name, label: name })),
    });
    if (isCancel(pmChoice)) {
      cancel("Operation cancelled.");
      process.exit(0);
    }
    pm = pmChoice as string;
  } else if (availablePMs.length === 1) {
    pm = availablePMs[0];
  }

  const s = spinner();
  s.start(`Installing dependencies with ${pm}...`);
  let installOk = false;
  try {
    execSync(`${pm} install`, { cwd: targetDir, stdio: "ignore" });
    installOk = true;
    s.stop(`Dependencies installed with ${pm}.`);
  } catch {
    s.stop(`Failed to install dependencies.`);
    log.warn(`Run \`${pm} install\` manually to install dependencies.`);
  }

  // Run vcc init interactively after successful install
  if (installOk) {
    try {
      execSync("npx vcc init", { cwd: targetDir, stdio: "inherit" });
    } catch {
      // vcc init failure is non-fatal
    }
  }

  const runCmd = pm === "yarn" ? `${pm} dev` : `${pm} run dev`;
  outro(`Done! Next steps:

  cd ${projectName}
  ${runCmd}

  Your app will be running at http://localhost:5173`);
}

main().catch(console.error);
