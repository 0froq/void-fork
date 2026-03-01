import { execFileSync, execSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { intro, outro, log, note, spinner, confirm, isCancel } from "@clack/prompts";
import { getToken, getTokenSource } from "./auth";
import { readProjectConfig, writeProjectConfig, type ProjectConfig } from "./project";
import {
  packageBuild,
  packageStaticBuild,
  packageFrameworkBuild,
  collectAndHashAssets,
} from "./package";
import { PlatformClient } from "./client";
import {
  inferProjectBindings,
  FRAMEWORK_SCAN_DIRS,
  detectFramework,
  type DetectedFramework,
} from "../plugin-inference";
import { promptProjectSelection, promptProjectSlug } from "./prompt";
import { collectMigrations } from "../migrations/collect";
import { validateMigrations } from "../migrations/validate";
import { scanJobsSync } from "../crons/scan";
import { scanQueuesSync } from "../queues/scan";
import { validateSsrEntry } from "../ssr/entry";
import { scanPages } from "../pages/scan";
import { collectPrerenderPaths } from "../prerender-paths";
import { detectPreset, FRAMEWORK_PRESETS, type StaticPreset, type FrameworkPreset } from "./preset";
import { readConfig, resolveBindingNames, type AuthProvider, type VoidConfig } from "../config";
import { readWranglerCompat } from "./wrangler";
import {
  needsWrapper,
  generateAndBundleWrapper,
  cleanupWrapper,
  type WrapperFeatures,
} from "./wrapper";
import { getRequestedProjectSlug, resolveProjectBySlug, inferDefaultSlug } from "./resolve-project";
import { cliTitle } from "./output";
import { parseHeadersFile, parseRedirectsFile } from "./headers";
import { convertHeadersConfig, convertRedirectsConfig } from "../config";
import type { AssetConfig, HeaderRule, RedirectRule } from "./types";

export interface RunDeployOptions {
  projectSlug?: string;
  dir?: string;
  spa?: boolean;
  skipBuild?: boolean;
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
  intro(cliTitle("deploy"));

  // 1. Auth
  const token = getToken();
  if (!token) {
    log.error("No auth token found. Run `void login` first.");
    process.exit(1);
  }

  const client = new PlatformClient(token);

  // 2. Resolve target project (CLI flag > env var > linked project file)
  const requestedProjectSlug = getRequestedProjectSlug(options);
  let config: ProjectConfig | null = null;

  if (requestedProjectSlug) {
    const projects = await client.listProjects();
    config = resolveProjectBySlug(projects, requestedProjectSlug);

    if (!config) {
      if (!process.stdin.isTTY) {
        log.error(`No project found with slug "${requestedProjectSlug}".`);
        process.exit(1);
      }

      const shouldCreate = await confirm({
        message: `Project "${requestedProjectSlug}" does not exist. Create it?`,
      });
      if (isCancel(shouldCreate) || !shouldCreate) {
        log.info("Deploy cancelled.");
        process.exit(0);
      }

      config = await createNewProject(root, client, requestedProjectSlug);
    }
  } else {
    config = readProjectConfig(root);
  }

  if (!config) {
    const projects = await client.listProjects();

    if (projects.length > 0) {
      // User has existing projects — let them choose
      const result = await promptProjectSelection(projects, "Select a project to deploy to:");

      if (result.action === "select") {
        config = { projectId: result.project.id, slug: result.project.slug };
        writeProjectConfig(root, config);
        log.step(`Linked to ${config.slug}`);
      } else {
        const slug = await promptProjectSlug(inferDefaultSlug(root));
        config = await createNewProject(root, client, slug);
      }
    } else {
      const slug = await promptProjectSlug(inferDefaultSlug(root));
      config = await createNewProject(root, client, slug);
    }
  }

  // 3. Resolve deploy app type: void.json > CLI flags > auto-detection
  const vcConfig = readConfig(root);

  // Check for Class B/C framework first
  const detected = detectFramework(root);
  if (detected && (detected.class === "b" || detected.class === "c")) {
    const fwPreset = FRAMEWORK_PRESETS[detected.name];
    if (!fwPreset) {
      log.error(`No deploy preset found for framework "${detected.name}".`);
      process.exit(1);
    }
    const gitCommit = options?.skipBuild ? null : getGitCommit(root);
    await runFrameworkDeploy(
      root,
      config,
      client,
      detected,
      fwPreset,
      vcConfig,
      options?.skipBuild,
      gitCommit,
    );
    return;
  }

  let preset: StaticPreset | null = null;

  if (vcConfig.appType && vcConfig.appType !== "void" && vcConfig.appType !== "framework") {
    // void.json has an explicit static app type
    preset = {
      buildCommand: null,
      outputDir: vcConfig.outputDir ? resolve(root, vcConfig.outputDir) : join(root, "dist"),
      appType: vcConfig.appType,
    };
    // Re-detect build command (config stores app type, not command)
    const detectedPreset = detectPreset(root, { dir: options?.dir, spa: options?.spa });
    if (detectedPreset) {
      preset.buildCommand = detectedPreset.buildCommand;
      if (!vcConfig.outputDir) {
        preset.outputDir = detectedPreset.outputDir;
      }
    }
  } else if (!vcConfig.appType) {
    // No configured app type — detect from CLI flags + project structure
    preset = detectPreset(root, { dir: options?.dir, spa: options?.spa });
  }
  // vcConfig.appType === "void" or "framework" → preset stays null → full deploy

  // Detect git commit before build (only when not skipping build)
  const gitCommit = options?.skipBuild ? null : getGitCommit(root);

  if (preset) {
    await runStaticDeploy(
      root,
      config,
      client,
      preset,
      options?.skipBuild,
      gitCommit,
      undefined,
      convertHeadersConfig(vcConfig.headers) ?? [],
      convertRedirectsConfig(vcConfig.redirects) ?? [],
    );
  } else {
    await runFullDeploy(root, config, client, options?.skipBuild, gitCommit);
  }
}

async function runStaticDeploy(
  root: string,
  config: ProjectConfig,
  client: PlatformClient,
  preset: StaticPreset,
  skipBuild?: boolean,
  commit?: string | null,
  hashedAssetsPrefix?: string,
  headerRules?: HeaderRule[],
  redirectRules?: RedirectRule[],
): Promise<void> {
  const typeLabel = preset.appType === "spa" ? "Static SPA" : "Static Site";
  log.info(`${typeLabel} deploy`);

  // Build (if needed)
  if (preset.buildCommand && !skipBuild) {
    log.step("Building...");
    execSync(preset.buildCommand, { cwd: root, stdio: "inherit" });
  }

  if (!existsSync(preset.outputDir)) {
    log.error(`Output directory not found: ${preset.outputDir}`);
    process.exit(1);
  }

  const s = spinner();

  // Preflight: hash assets and check which ones changed
  s.start("Checking for changes...");
  const { assetManifest } = collectAndHashAssets(preset.outputDir);
  const { needed, skipped } = await client.preflight(config.projectId, assetManifest);

  if (skipped > 0) {
    log.info(`Skipping ${skipped} unchanged asset(s)`);
  }

  s.message("Packaging...");
  const neededSet = skipped > 0 ? new Set(needed) : null;
  const formData = packageStaticBuild(
    preset.outputDir,
    preset.appType,
    neededSet,
    hashedAssetsPrefix ?? "assets",
    headerRules,
    redirectRules,
  );
  formData.append("source", getTokenSource());
  if (commit) formData.append("commit", commit);

  s.message("Deploying...");
  const result = await client.deploy(config.projectId, formData);
  s.stop("Deployed!");

  const uploaded = result.assets - skipped;
  const assetSummary =
    skipped > 0
      ? `${result.assets} static asset(s) (${skipped} unchanged, ${uploaded} uploaded)`
      : `${result.assets} static asset(s)`;
  const summary = [`${typeLabel} — ${assetSummary}`];
  note(summary.join("\n"), result.url);

  outro("Done!");
}

/**
 * Class B/C framework deploy: build with framework CLI, package with preset output paths.
 */
async function runFrameworkDeploy(
  root: string,
  config: ProjectConfig,
  client: PlatformClient,
  detected: DetectedFramework,
  fwPreset: FrameworkPreset,
  vcConfig: VoidConfig,
  skipBuild?: boolean,
  commit?: string | null,
): Promise<void> {
  log.info(`${detected.name} (Class ${detected.class.toUpperCase()}) deploy`);

  // 1. Build
  if (!skipBuild) {
    const buildCmd = vcConfig.build ?? fwPreset.buildCommand;
    log.step(`Building (${buildCmd})...`);
    execSync(buildCmd, { cwd: root, stdio: "inherit" });
  }

  // 2. Verify output paths
  const workerDir = join(root, fwPreset.workerDir);
  const assetsDir = join(root, fwPreset.assetsDir);

  // Collect header rules: parse framework-generated _headers file + void.json config
  const fwHeaderRules = existsSync(assetsDir) ? parseHeadersFile(assetsDir) : undefined;
  const cfgHeaderRules = convertHeadersConfig(vcConfig.headers);
  const headerRules: HeaderRule[] = [...(fwHeaderRules ?? []), ...(cfgHeaderRules ?? [])];

  // Collect redirect rules: parse framework-generated _redirects file + void.json config
  const fwRedirectRules = existsSync(assetsDir) ? parseRedirectsFile(assetsDir) : undefined;
  const cfgRedirectRules = convertRedirectsConfig(vcConfig.redirects);
  const redirectRules: RedirectRule[] = [...(fwRedirectRules ?? []), ...(cfgRedirectRules ?? [])];

  if (!existsSync(workerDir)) {
    log.error(`Worker output not found: ${fwPreset.workerDir}`);
    process.exit(1);
  }

  // 3. Infer or read bindings
  const inferenceOptions = vcConfig.bindings ? { bindings: vcConfig.bindings } : undefined;
  const scanDirs = vcConfig.scanDirs ?? FRAMEWORK_SCAN_DIRS;
  const bindings = inferProjectBindings(root, inferenceOptions, scanDirs);

  // 4. Collect migrations
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

  // 5. Resolve auth config (explicit config takes precedence, otherwise infer from source)
  const authProviders: AuthProvider[] | null = vcConfig.auth
    ? vcConfig.auth === true
      ? (["email"] as AuthProvider[])
      : vcConfig.auth
    : bindings.needsAuth
      ? ["email"]
      : null;

  // 7. Generate wrapper if needed (auth, crons, or queues present)
  const rawJobs = scanJobsSync(root);
  const rawQueues = scanQueuesSync(root);
  const originalEntry = join(workerDir, fwPreset.workerMain);

  const wrapperFeatures: WrapperFeatures = {
    originalEntry,
    auth: authProviders,
    crons: rawJobs,
    queues: rawQueues,
  };

  let actualWorkerDir = workerDir;
  let actualWorkerMain = fwPreset.workerMain;

  if (needsWrapper(wrapperFeatures)) {
    log.step("Generating wrapper...");
    const wrapperResult = await generateAndBundleWrapper(root, wrapperFeatures);
    actualWorkerDir = wrapperResult.outputDir;
    actualWorkerMain = wrapperResult.entryFilename;
    log.info("Wrapper bundled");
  }

  // 8. Read wrangler compat settings (void.json > wrangler.jsonc > default)
  const wranglerCompat = readWranglerCompat(root, vcConfig);

  // 9. Resolve revalidate + prerender from void.json
  const revalidate = vcConfig.cache?.revalidate;
  const prerender = vcConfig.cache?.prerender;

  // Build manifest-format schedules and queues from raw scans
  const schedules = rawJobs.flatMap((job) =>
    job.crons.map((cron) => ({
      name: job.name,
      cron,
    })),
  );
  const queues = rawQueues.map((q) => ({
    name: q.name,
    bindingName: q.bindingName,
    ...(q.maxBatchSize != null && { maxBatchSize: q.maxBatchSize }),
    ...(q.maxBatchTimeout != null && { maxBatchTimeout: q.maxBatchTimeout }),
  }));

  // 10. Load .env vars for production (excludes .local files)
  const envVars = loadDeployEnv(root);

  // 11. Package & deploy
  const s = spinner();

  // Preflight: hash assets and check which ones changed
  s.start("Checking for changes...");
  const { assetManifest } = collectAndHashAssets(assetsDir);
  const { needed, skipped } = await client.preflight(config.projectId, assetManifest);

  if (skipped > 0) {
    log.info(`Skipping ${skipped} unchanged asset(s)`);
  }

  s.message("Packaging...");
  const neededSet = skipped > 0 ? new Set(needed) : null;
  const formData = packageFrameworkBuild({
    workerDir: actualWorkerDir,
    workerMain: actualWorkerMain,
    assetsDir,
    bindings,
    migrations: validatedMigrations,
    schedules,
    queues,
    revalidate,
    prerender,
    assetConfig: { not_found_handling: "none" },
    vars: envVars,
    packageOptions: {
      bindingNames: resolveBindingNames(vcConfig.bindings),
      workerMain: actualWorkerMain,
      compatibilityDate: wranglerCompat.compatibilityDate,
      compatibilityFlags: wranglerCompat.compatibilityFlags,
    },
    neededAssets: neededSet,
    hashedAssetsPrefix: fwPreset.hashedAssetsPrefix ?? "assets",
    headerRules,
    redirectRules,
  });
  formData.append("source", getTokenSource());
  if (commit) formData.append("commit", commit);

  s.message("Deploying...");
  const result = await client.deploy(config.projectId, formData);
  s.stop("Deployed!");

  const uploaded = result.assets - skipped;
  const assetSummary =
    skipped > 0
      ? `${result.assets} static asset(s) (${skipped} unchanged, ${uploaded} uploaded)`
      : `${result.assets} static asset(s)`;
  const summary = [`${result.workers} worker module(s), ${assetSummary}`];
  if (result.migrations) {
    summary.push(`${result.migrations} migration(s) applied`);
  }
  if (schedules.length > 0) {
    summary.push(`${schedules.length} cron job(s) scheduled`);
  }
  if (queues.length > 0) {
    summary.push(`${queues.length} queue(s) configured`);
  }
  if (prerender && prerender.length > 0) {
    summary.push(`${prerender.length} page(s) prerendered`);
  }
  if (revalidate) {
    if (typeof revalidate === "number") {
      summary.push(`ISR revalidate: ${revalidate}s`);
    } else {
      summary.push(`ISR revalidate: ${Object.keys(revalidate).length} path rule(s)`);
    }
  }
  summary.push(`Framework: ${detected.name}`);
  note(summary.join("\n"), result.url);

  // Clean up generated wrapper files
  cleanupWrapper(root);

  outro("Done!");
}

async function runFullDeploy(
  root: string,
  config: ProjectConfig,
  client: PlatformClient,
  skipBuild?: boolean,
  commit?: string | null,
): Promise<void> {
  // 3. Build (child process to avoid Vite API side effects on bundle output)
  if (!skipBuild) {
    log.step("Building...");
    const viteBin = fileURLToPath(
      new URL("bin/vite.js", import.meta.resolve("vite/package.json")).href,
    );
    try {
      execFileSync(process.execPath, [viteBin, "build"], { cwd: root, stdio: "inherit" });
    } catch (err: any) {
      process.exit(err.status ?? 1);
    }
  }

  // 4. Resolve build output paths from build artifacts (avoids re-resolving
  // Vite config in the main process — plugins only run once inside the build)
  const distDir = join(root, "dist");

  // Detect non-default assetsDir from Vite client manifest for _headers generation
  let assetsPrefix = "assets";
  const clientManifestPath = join(distDir, "client", ".vite", "manifest.json");
  if (existsSync(clientManifestPath)) {
    const manifest: Record<string, { file?: string }> = JSON.parse(
      readFileSync(clientManifestPath, "utf-8"),
    );
    for (const entry of Object.values(manifest)) {
      if (entry.file?.includes("/")) {
        const dir = entry.file.slice(0, entry.file.indexOf("/"));
        if (dir !== "assets") assetsPrefix = dir;
        break;
      }
    }
  }

  // 5. Detect framework mode (Class A only for existing flow)
  const detected = detectFramework(root);
  const isFrameworkMode = detected?.class === "a";

  // 6. Infer bindings (expanded scan dirs in framework mode, or custom from config)
  const deployConfig = readConfig(root);
  const deployScanDirs =
    deployConfig.scanDirs ?? (isFrameworkMode ? FRAMEWORK_SCAN_DIRS : undefined);
  const bindings = inferProjectBindings(root, undefined, deployScanDirs);

  // Collect header rules: parse user/framework _headers file + void.json config
  const clientDir = join(distDir, "client");
  const userHeaderRules = existsSync(clientDir) ? parseHeadersFile(clientDir) : undefined;
  const cfgHeaderRules = convertHeadersConfig(deployConfig.headers);
  const headerRules: HeaderRule[] = [...(userHeaderRules ?? []), ...(cfgHeaderRules ?? [])];

  // Collect redirect rules: parse user/framework _redirects file + void.json config
  const userRedirectRules = existsSync(clientDir) ? parseRedirectsFile(clientDir) : undefined;
  const cfgRedirectRules = convertRedirectsConfig(deployConfig.redirects);
  const redirectRules: RedirectRule[] = [...(userRedirectRules ?? []), ...(cfgRedirectRules ?? [])];

  // 7. Collect and validate migrations
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
  const workerDirName = detectWorkerDir(distDir);

  const schedules = scanJobsSync(root).flatMap((job) =>
    job.crons.map((cron) => ({
      name: job.name,
      cron,
    })),
  );
  const queues = scanQueuesSync(root).map((q) => ({
    name: q.name,
    bindingName: q.bindingName,
    ...(q.maxBatchSize != null && { maxBatchSize: q.maxBatchSize }),
    ...(q.maxBatchTimeout != null && { maxBatchTimeout: q.maxBatchTimeout }),
  }));
  const isSsr = isFrameworkMode ? true : Boolean(validateSsrEntry(root));

  // Resolve revalidate config from void.json + per-page .server.ts exports
  const vcRevalidate = readConfig(root).cache?.revalidate;
  let revalidate: number | Record<string, number> | undefined;
  if (vcRevalidate != null) {
    revalidate = vcRevalidate;
  }
  // Merge per-page revalidate exports (pages mode)
  const pageScan = existsSync(join(root, "pages"))
    ? await scanPages(root, { output: deployConfig.output })
    : null;
  if (pageScan) {
    const perPageRules: Record<string, number> = {};
    for (const page of pageScan.pages) {
      if (page.revalidate != null) {
        perPageRules[page.pattern] = page.revalidate;
      }
    }
    if (Object.keys(perPageRules).length > 0) {
      if (typeof revalidate === "number") {
        // Global number → pathmap with "*" fallback, per-page entries first
        revalidate = Object.fromEntries([...Object.entries(perPageRules), ["*", revalidate]]);
      } else if (typeof revalidate === "object") {
        // Per-page entries first (higher precedence in first-match)
        revalidate = Object.fromEntries([
          ...Object.entries(perPageRules),
          ...Object.entries(revalidate),
        ]);
      } else {
        revalidate = perPageRules;
      }
    }
  }

  // Fully-static optimization: if output: "static" and all pages are prerendered
  // with no backend features, deploy as a static site (no worker needed)
  if (deployConfig.output === "static" && pageScan && !isSsr) {
    const allPrerenderable = pageScan.pages.every(
      (p) => p.prerender && ((p.params.length === 0 && !p.catchAll) || p.hasGetPrerenderPaths),
    );
    const hasNonPageBackend =
      existsSync(join(root, "routes")) || existsSync(join(root, "middleware"));
    if (allPrerenderable && !hasNonPageBackend && schedules.length === 0 && queues.length === 0) {
      log.info("All pages prerendered — deploying as static site");
      return runStaticDeploy(
        root,
        config,
        client,
        {
          buildCommand: null,
          outputDir: clientDir,
          appType: "static",
        },
        true,
        commit,
        assetsPrefix,
        headerRules,
        redirectRules,
      );
    }
  }

  // Resolve prerender paths (skip when output: "static" — pages are already built as static assets)
  const uniquePrerenderPaths =
    deployConfig.output === "static"
      ? []
      : await collectPrerenderPaths({ root, config: deployConfig });

  // 8. Read wrangler compat settings (void.json > wrangler.jsonc > default)
  const wranglerCompat = readWranglerCompat(root, deployConfig);

  // 9. Load .env vars for production (excludes .local files)
  const envVars = loadDeployEnv(root);

  // 10. Package & Upload
  const s = spinner();

  // Derive asset config: SSR workers handle their own 404s, non-SSR uses SPA fallback
  const assetConfig: AssetConfig = isSsr
    ? { not_found_handling: "none" }
    : { not_found_handling: "single-page-application" };

  // Preflight: hash assets and check which ones changed
  s.start("Checking for changes...");
  const { assetManifest } = collectAndHashAssets(clientDir);
  const { needed, skipped } = await client.preflight(config.projectId, assetManifest);

  if (skipped > 0) {
    log.info(`Skipping ${skipped} unchanged asset(s)`);
  }

  s.message("Packaging...");
  const neededSet = skipped > 0 ? new Set(needed) : null;
  const formData = packageBuild(
    distDir,
    workerDirName,
    bindings,
    validatedMigrations,
    schedules,
    isSsr,
    isFrameworkMode,
    revalidate,
    envVars,
    queues,
    uniquePrerenderPaths,
    assetConfig,
    {
      compatibilityDate: wranglerCompat.compatibilityDate,
      compatibilityFlags: wranglerCompat.compatibilityFlags,
    },
    neededSet,
    assetsPrefix,
    headerRules,
    redirectRules,
  );
  formData.append("source", getTokenSource());
  if (commit) formData.append("commit", commit);

  s.message("Deploying...");
  const result = await client.deploy(config.projectId, formData);
  s.stop("Deployed!");

  const uploaded = result.assets - skipped;
  const assetSummary =
    skipped > 0
      ? `${result.assets} static asset(s) (${skipped} unchanged, ${uploaded} uploaded)`
      : `${result.assets} static asset(s)`;
  const summary = [`${result.workers} worker module(s), ${assetSummary}`];
  if (result.migrations) {
    summary.push(`${result.migrations} migration(s) applied`);
  }
  if (schedules.length > 0) {
    summary.push(`${schedules.length} cron job(s) scheduled`);
  }
  if (queues.length > 0) {
    summary.push(`${queues.length} queue(s) configured`);
  }
  if (uniquePrerenderPaths.length > 0) {
    summary.push(`${uniquePrerenderPaths.length} page(s) prerendered`);
  }
  if (isSsr) {
    summary.push("SSR enabled");
  }
  if (revalidate) {
    if (typeof revalidate === "number") {
      summary.push(`ISR revalidate: ${revalidate}s`);
    } else {
      summary.push(`ISR revalidate: ${Object.keys(revalidate).length} path rule(s)`);
    }
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
  const projectSlug = slug ?? inferDefaultSlug(root);

  log.step(`Creating project "${projectSlug}"...`);
  const project = await client.createProject(projectSlug);
  const config = { projectId: project.id, slug: project.slug };
  writeProjectConfig(root, config);
  log.success(`Project created: ${config.slug}`);
  return config;
}

function getGitCommit(root: string): string | null {
  try {
    // Check if in a git repo
    execSync("git rev-parse --is-inside-work-tree", { cwd: root, stdio: "ignore" });
    // Check if working tree is clean
    const status = execSync("git status --porcelain", { cwd: root, encoding: "utf-8" }).trim();
    if (status !== "") return null;
    // Get current commit hash
    return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

/**
 * Load env vars for deploy — only .env and .env.production (not .local files).
 * Later files win on conflict.
 */
function loadDeployEnv(root: string): Record<string, string> {
  const files = [".env", ".env.production"];
  const env: Record<string, string> = {};
  for (const file of files) {
    const filePath = join(root, file);
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      // Strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
  }
  return env;
}

/**
 * Detect the worker output directory name.
 * With viteEnvironment: { name: "ssr" }, output is always dist/ssr/.
 */
export function detectWorkerDir(distDir: string): string {
  const ssrPath = join(distDir, "ssr");
  if (existsSync(ssrPath)) return "ssr";

  throw new Error(`Worker output not found: expected ${ssrPath}`);
}
