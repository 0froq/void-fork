import { execSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { getToken } from "./auth";
import { readProjectConfig, writeProjectConfig } from "./project";
import { packageBuild } from "./package";
import { PlatformClient } from "./client";
import { inferProjectBindings } from "../plugin-inference";
import { promptProjectSelection } from "./prompt";

/**
 * Run the full deploy pipeline:
 * 1. Check auth
 * 2. Run vite build
 * 3. Package output
 * 4. Upload to platform
 * 5. Print live URL
 */
export async function runDeploy(root: string): Promise<void> {
  // 1. Auth
  const token = getToken();
  if (!token) {
    console.error(
      "Error: No auth token found.\n" +
        "Set VITE_CLOUD_TOKEN environment variable or run `vite-cloud login`.",
    );
    process.exit(1);
  }

  const client = new PlatformClient(token);

  // 2. Read or create project config
  let config = readProjectConfig(root);
  if (!config) {
    const projects = await client.listProjects();

    if (projects.length > 0) {
      // User has existing projects — let them choose
      const result = await promptProjectSelection(projects);

      if (result.action === "select") {
        config = { projectId: result.project.id, slug: result.project.slug };
        writeProjectConfig(root, config);
        console.log(`Linked to ${config.slug}`);
      } else {
        // User wants to create a new project — fall through
        config = await createNewProject(root, client);
      }
    } else {
      // No existing projects — go straight to create flow
      config = await createNewProject(root, client);
    }
  }

  // 3. Build
  console.log("Building...");
  execSync("npx vite build", { cwd: root, stdio: "inherit" });

  // 4. Infer bindings
  const bindings = inferProjectBindings(root);

  // 5. Detect worker directory name from dist/
  const workerDirName = detectWorkerDir(root);

  // 6. Package
  console.log("Packaging...");
  const distDir = join(root, "dist");
  const formData = packageBuild(distDir, workerDirName, bindings);

  // 7. Upload
  console.log("Deploying...");
  const result = await client.deploy(config.projectId, formData);

  console.log(`\nDeployed! ${result.url}`);
  console.log(`  ${result.workers} worker module(s), ${result.assets} static asset(s)`);
}

import type { ProjectConfig } from "./project";

async function createNewProject(root: string, client: PlatformClient): Promise<ProjectConfig> {
  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const name = pkg.name ?? "my-app";
  const slug = name.replace(/^@[^/]+\//, "").replace(/[^a-z0-9-]/g, "-");

  console.log(`Creating project "${slug}"...`);
  const project = await client.createProject(slug, name);
  const config = { projectId: project.id, slug: project.slug };
  writeProjectConfig(root, config);
  console.log(`Project created: ${config.slug}`);
  return config;
}

/**
 * Detect the worker output directory name.
 * Vite + @cloudflare/vite-plugin outputs worker files to dist/<package-name>/
 */
function detectWorkerDir(root: string): string {
  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  // The CF plugin uses the package name (without scope) as the output dir
  const name: string = pkg.name ?? "worker";
  return name.replace(/^@[^/]+\//, "");
}
