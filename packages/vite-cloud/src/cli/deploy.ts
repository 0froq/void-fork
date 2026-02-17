import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { intro, outro, log, note, spinner } from "@clack/prompts";
import { getToken, getTokenSource } from "./auth";
import { readProjectConfig, writeProjectConfig, type ProjectConfig } from "./project";
import { computeAssetHashes, packageBuild, packageStaticBuild } from "./package";
import { PlatformClient, type ProjectResponse } from "./client";
import { inferProjectBindings, FRAMEWORK_SCAN_DIRS, detectFramework } from "../plugin-inference";
import { promptProjectSelection, promptProjectSlug } from "./prompt";
import { collectMigrations } from "../migrations/collect";
import { validateMigrations } from "../migrations/validate";
import { scanJobsSync } from "../jobs/scan";
import { validateSsrEntry, getRevalidateConfig } from "../ssr/entry";
import { detectPreset, type StaticPreset } from "./preset";
import { readConfig, convertHeadersConfig } from "../config";

export interface RunDeployOptions {
  projectSlug?: string;
  dir?: string;
  spa?: boolean;
}

export function getRequestedProjectSlug(options?: RunDeployOptions): string | null {
  const cliSlug = options?.projectSlug?.trim();
  if (cliSlug) {
    return cliSlug;
  }

  const envSlug = process.env.VITE_CLOUD_PROJECT?.trim();
  if (envSlug) {
    return envSlug;
  }

  return null;
}

export function resolveProjectBySlug(projects: ProjectResponse[], slug: string): ProjectConfig {
  const project = projects.find((candidate) => candidate.slug === slug);
  if (!project) {
    throw new Error(`No project found with slug "${slug}".`);
  }

  return { projectId: project.id, slug: project.slug };
}

export function inferDefaultProjectNameAndSlug(root: string): { name: string; slug: string } {
  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const name = pkg.name ?? "my-app";
  const slug = name.replace(/^@[^/]+\//, "").replace(/[^a-z0-9-]/g, "-");
  return { name, slug };
}

/**
 * Run the full deploy pipeline:
 * 1. Check auth
 * 2. Resolve project + deploy mode
 * 3. Build (if needed)
 * 4. Package output
 * 5. Upload to platform
 * 6. Print live URL
 */
export async function runDeploy(root: string, options?: RunDeployOptions): Promise<void> {
  console.log();
  intro("\x1b[34mvite-cloud deploy\x1b[0m");

  // 1. Auth
  const token = getToken();
  if (!token) {
    log.error("No auth token found. Run `vcd login` first.");
    process.exit(1);
  }

  const client = new PlatformClient(token);

  // 2. Resolve target project (CLI flag > env var > linked project file)
  const requestedProjectSlug = getRequestedProjectSlug(options);
  let config: ProjectConfig | null = null;

  if (requestedProjectSlug) {
    const projects = await client.listProjects();
    config = resolveProjectBySlug(projects, requestedProjectSlug);
  } else {
    config = readProjectConfig(root);
  }

  if (!config) {
    const projects = await client.listProjects();

    if (projects.length > 0) {
      // User has existing projects — let them choose
      const result = await promptProjectSelection(projects);

      if (result.action === "select") {
        config = { projectId: result.project.id, slug: result.project.slug };
        writeProjectConfig(root, config);
        log.step(`Linked to ${config.slug}`);
      } else {
        const inferred = inferDefaultProjectNameAndSlug(root);
        const slug = await promptProjectSlug(inferred.slug);
        config = await createNewProject(root, client, slug);
      }
    } else {
      const inferred = inferDefaultProjectNameAndSlug(root);
      const slug = await promptProjectSlug(inferred.slug);
      config = await createNewProject(root, client, slug);
    }
  }

  // 3. Resolve deploy mode: vite-cloud.json > CLI flags > auto-detection
  const vcConfig = readConfig(root);
  const headers = convertHeadersConfig(vcConfig.headers);
  let preset: StaticPreset | null = null;

  if (vcConfig.mode && vcConfig.mode !== "fullstack" && vcConfig.mode !== "framework") {
    // vite-cloud.json has an explicit static mode
    preset = {
      buildCommand: null,
      outputDir: vcConfig.outputDir ? resolve(root, vcConfig.outputDir) : join(root, "dist"),
      mode: vcConfig.mode,
    };
    // Re-detect build command (config stores mode, not command)
    const detected = detectPreset(root, { dir: options?.dir, spa: options?.spa });
    if (detected) {
      preset.buildCommand = detected.buildCommand;
      if (!vcConfig.outputDir) {
        preset.outputDir = detected.outputDir;
      }
    }
  } else if (!vcConfig.mode) {
    // No configured mode — detect from CLI flags + project structure
    preset = detectPreset(root, { dir: options?.dir, spa: options?.spa });
  }
  // vcConfig.mode === "fullstack" or "framework" → preset stays null → full deploy

  if (preset) {
    await runStaticDeploy(root, config, client, preset, headers);
  } else {
    await runFullDeploy(root, config, client, headers);
  }
}

async function runStaticDeploy(
  root: string,
  config: ProjectConfig,
  client: PlatformClient,
  preset: StaticPreset,
  headers?: import("./types").HeaderRule[],
): Promise<void> {
  const modeLabel = preset.mode === "spa" ? "Static SPA" : "Static SSG";
  log.info(`${modeLabel} deploy`);

  // Build (if needed)
  if (preset.buildCommand) {
    log.step("Building...");
    execSync(preset.buildCommand, { cwd: root, stdio: "inherit" });
  }

  if (!existsSync(preset.outputDir)) {
    log.error(`Output directory not found: ${preset.outputDir}`);
    process.exit(1);
  }

  // Package & Upload
  const s = spinner();

  s.start("Checking assets...");
  const hashes = computeAssetHashes(preset.outputDir);
  const totalAssets = Object.keys(hashes).length;
  const needed = await client.checkAssets(config.projectId, hashes);
  s.message(
    `Uploading ${needed.length}/${totalAssets} assets (${totalAssets - needed.length} cached)`,
  );
  const formData = packageStaticBuild(
    preset.outputDir,
    preset.mode,
    new Set(needed),
    hashes,
    headers,
  );
  formData.append("source", getTokenSource());

  s.message("Deploying...");
  const result = await client.deploy(config.projectId, formData);
  s.stop("Deployed!");

  const summary = [`${modeLabel} — ${result.assets} static asset(s)`];
  note(summary.join("\n"), result.url);

  outro("Done!");
}

async function runFullDeploy(
  root: string,
  config: ProjectConfig,
  client: PlatformClient,
  headers?: import("./types").HeaderRule[],
): Promise<void> {
  // 3. Build
  log.step("Building...");
  execSync("npx vite build", { cwd: root, stdio: "inherit" });

  // 4. Detect framework mode
  const isFrameworkMode = detectFramework(root) !== undefined;

  // 5. Infer bindings (expanded scan dirs in framework mode)
  const bindings = inferProjectBindings(
    root,
    undefined,
    isFrameworkMode ? FRAMEWORK_SCAN_DIRS : undefined,
  );

  // 6. Collect and validate migrations
  const migrationsDir = join(root, "migrations");
  const rawMigrations = collectMigrations(migrationsDir);
  let validatedMigrations;
  if (rawMigrations.length > 0) {
    try {
      validatedMigrations = validateMigrations(rawMigrations);
      log.info(`Found ${validatedMigrations.length} migration(s)`);
    } catch (err: any) {
      log.error(err.message);
      process.exit(1);
    }
  }

  const distDir = join(root, "dist");
  const workerDirName = detectWorkerDir(root, distDir);

  // In framework mode: skip job scanning, SSR is always true
  const schedules = isFrameworkMode
    ? []
    : scanJobsSync(root).map((job) => ({
        name: job.name,
        cron: job.cron,
      }));
  const isSsr = isFrameworkMode ? true : Boolean(validateSsrEntry(root));
  const revalidateConfig = isSsr ? getRevalidateConfig(root) : { type: "none" as const };
  const revalidateTtl =
    revalidateConfig.type === "static" && revalidateConfig.ttl > 0
      ? revalidateConfig.ttl
      : undefined;

  // 7. Check assets & Package & Upload
  const s = spinner();

  s.start("Checking assets...");
  const clientDir = join(distDir, "client");
  let neededPaths: Set<string> | undefined;
  let assetHashes: Record<string, string> | undefined;
  try {
    assetHashes = computeAssetHashes(clientDir);
    const totalAssets = Object.keys(assetHashes).length;
    const needed = await client.checkAssets(config.projectId, assetHashes);
    neededPaths = new Set(needed);
    s.message(
      `Uploading ${needed.length}/${totalAssets} assets (${totalAssets - needed.length} cached)`,
    );
  } catch {
    // No client directory — API-only project
  }

  s.message("Packaging...");
  const formData = packageBuild(
    distDir,
    workerDirName,
    bindings,
    validatedMigrations,
    schedules,
    isSsr,
    isFrameworkMode,
    neededPaths,
    assetHashes,
    headers,
    revalidateTtl,
  );
  formData.append("source", getTokenSource());

  s.message("Deploying...");
  const result = await client.deploy(config.projectId, formData);
  s.stop("Deployed!");

  const summary = [`${result.workers} worker module(s), ${result.assets} static asset(s)`];
  if (result.migrations) {
    summary.push(`${result.migrations} migration(s) applied`);
  }
  if (schedules.length > 0) {
    summary.push(`${schedules.length} cron job(s) scheduled`);
  }
  if (isSsr) {
    summary.push("SSR enabled");
  }
  if (revalidateTtl) {
    summary.push(`ISR revalidate: ${revalidateTtl}s`);
  }
  if (isFrameworkMode) {
    summary.push("Framework mode");
  }
  note(summary.join("\n"), result.url);

  outro("Done!");
}

async function createNewProject(
  root: string,
  client: PlatformClient,
  slug?: string,
): Promise<ProjectConfig> {
  const inferred = inferDefaultProjectNameAndSlug(root);
  const projectSlug = slug ?? inferred.slug;
  const name = inferred.name;

  log.step(`Creating project "${projectSlug}"...`);
  const project = await client.createProject(projectSlug, name);
  const config = { projectId: project.id, slug: project.slug };
  writeProjectConfig(root, config);
  log.success(`Project created: ${config.slug}`);
  return config;
}

/**
 * Detect the worker output directory name.
 * Cloudflare Vite plugin defaults worker build output to dist/<environmentName>,
 * where environmentName is workerName with "-" replaced by "_".
 * If not found, fall back to discovery for custom environment/outDir overrides.
 */
export function detectWorkerDir(root: string, distDir: string): string {
  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const packageName: string = pkg.name ?? "worker";
  const workerName = packageName.replace(/^@[^/]+\//, "");
  const expected = workerName.replaceAll("-", "_");

  const expectedPath = join(distDir, expected);
  if (existsSync(expectedPath)) {
    return expected;
  }

  if (!existsSync(distDir)) {
    throw new Error(`Build output not found: ${distDir}`);
  }

  const candidates = readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== "client" && !name.startsWith("."));

  if (candidates.length === 1) {
    return candidates[0];
  }

  if (candidates.length === 0) {
    throw new Error(`No worker output directory found in ${distDir}. Expected ${expectedPath}.`);
  }

  throw new Error(
    `Could not determine worker output directory in ${distDir}. Expected ${expectedPath}. Found multiple candidates: ${candidates.join(
      ", ",
    )}`,
  );
}
