import { intro, outro, text, select, isCancel, cancel } from "@clack/prompts";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const FRAMEWORKS = {
  react: { name: "React", color: "\x1b[36m" },
  vue: { name: "Vue", color: "\x1b[32m" },
  svelte: { name: "Svelte", color: "\x1b[33m" },
  solid: { name: "Solid", color: "\x1b[34m" },
  vanilla: { name: "Vanilla", color: "\x1b[37m" },
} as const;

type Framework = keyof typeof FRAMEWORKS;

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

  const framework = await select({
    message: "Framework:",
    options: Object.entries(FRAMEWORKS).map(([value, { name }]) => ({
      value: value as Framework,
      label: name,
    })),
  });

  if (isCancel(framework)) {
    cancel("Operation cancelled.");
    process.exit(0);
  }

  const targetDir = resolve(process.cwd(), projectName);

  // Copy template
  const templateDir = join(__dirname, "..", "template");
  mkdirSync(targetDir, { recursive: true });
  cpSync(templateDir, targetDir, { recursive: true });

  // Update package.json with project name
  const pkgPath = join(targetDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  pkg.name = projectName;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  outro(`Done! Next steps:

  cd ${projectName}
  npm install
  npm run dev

  Your app will be running at http://localhost:5173`);
}

main().catch(console.error);
