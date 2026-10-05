import { existsSync } from 'node:fs';
import { activateCloudflareVersion } from '@void/deploy-cloudflare';
import { join } from 'pathslash';
import { materializeCloudflareConfig } from '../cloudflare-config.ts';
import { readConfig, isNodeTarget } from '../config.ts';
import { detectFramework } from '../plugin-inference.ts';
import { trustedCloudflareWorkerAccessHeaders } from '../shared/cf-access.ts';
import { readCloudflareCandidate } from './cloudflare-candidate.ts';
import { readCloudflareLink } from './cloudflare-link.ts';
import {
  hasConfiguredVoidWorkerRoutingRules,
  removeDeployPointer,
} from './deploy-artifact-validation.ts';
import { buildCloudflareWorker } from './deploy-cloudflare-build.ts';
import { migrateCloudflareWorker } from './deploy-cloudflare-migrate.ts';
import {
  prepareCloudflareDeploySource,
  preflightCloudflareWorker,
} from './deploy-cloudflare-preflight.ts';
import { publishCloudflareWorker } from './deploy-cloudflare-publish.ts';
import {
  resolveCloudflareStaticPreset,
  resolveCloudflareVoidStaticPreset,
  runCloudflareStaticDeploy,
} from './deploy-cloudflare-static.ts';
import { log } from './deploy-helpers.ts';
import { loadProvisionModule } from './deploy-provision.ts';
import { printDeploySuccess } from './deploy-summary.ts';
import { type RunDeployOptions, type CloudflareDeployDeps } from './deploy-types.ts';
import { renderAddressMap } from './email-cloudflare.ts';
import { type CliLogger } from './log-file.ts';
import { createSpinner } from './output.ts';
import { FRAMEWORK_PRESETS } from './preset.ts';

/** Deploy to the user's own Cloudflare account through the guarded native Worker flow. */
export async function runCloudflareDeploy(
  root: string,
  options: RunDeployOptions,
  cliLog: CliLogger,
  deps: CloudflareDeployDeps = {},
): Promise<void> {
  const initialCloudflareLink = readCloudflareLink(root);
  const initialCloudflareCandidate = readCloudflareCandidate(root);
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  const voidConfig = readConfig(root);
  const atomic = options.atomic === true || voidConfig.deploy?.cloudflare?.mode === 'atomic';
  if (atomic && (options.reuseExistingWorker || initialCloudflareLink)) {
    log.error(
      'deploy: atomic deployment is unavailable during the existing Worker handoff. Complete the handoff first.',
    );
    return exit(1);
  }
  const detectedFramework = detectFramework(root);
  const frameworkPreset = detectedFramework ? FRAMEWORK_PRESETS[detectedFramework.name] : undefined;
  cliLog.info('cloudflare_deploy_start', {
    provision: options.provision === true ? true : undefined,
  });

  // Static deploys branch before the full Worker classifier, so keep the
  // runtime-target guard ahead of both paths. An explicit Cloudflare deploy
  // must never reinterpret a node/bun/deno project as a Workers Assets app.
  if (isNodeTarget(voidConfig.target)) {
    log.error(
      [
        `deploy: --platform cloudflare is not supported for the "${voidConfig.target}" target.`,
        'This backend deploys Cloudflare Workers only. Deploy a node/bun/deno build with its',
        'own host/runtime, or use the default Cloudflare target for --platform cloudflare.',
      ].join('\n'),
    );
    return exit(1);
  }

  if (detectedFramework?.class === 'a' && hasConfiguredVoidWorkerRoutingRules(voidConfig.routing)) {
    log.error(
      [
        `deploy: native Cloudflare deployment cannot apply Void routing redirects, rewrites, fallbacks, or headers to ${detectedFramework.name}.`,
        'This framework owns its Worker request handler, so these rules would otherwise be ignored.',
        'Move the rules into the framework or its Cloudflare Worker, then retry.',
      ].join('\n'),
    );
    return exit(1);
  }

  const provisionModule = await loadProvisionModule();
  const staticPreset =
    resolveCloudflareStaticPreset(root, voidConfig, options) ??
    (await resolveCloudflareVoidStaticPreset(root, voidConfig));
  if (staticPreset) {
    if (atomic) {
      log.error('deploy: atomic deployment is only for Workers with Durable Objects.');
      return exit(1);
    }
    return runCloudflareStaticDeploy(
      root,
      options,
      voidConfig,
      staticPreset,
      cliLog,
      deps,
      initialCloudflareLink,
      initialCloudflareCandidate,
    );
  }

  const source = await prepareCloudflareDeploySource(root, options, voidConfig);
  if (!source) {
    return exit(1);
  }
  const {
    configPath,
    desired,
    reasons,
    authEnabled,
    dialect,
    migrationsDir,
    migrations: preBuildMigrations,
    needsAI,
    aiBindingName,
    needsSandbox,
    needsLive,
    expectedCrons,
    needsEmail,
    emailHandlers,
  } = source;

  // (The auth-migration guard runs at 3d below, AFTER the transport + account pin, so it can
  // derive the Better Auth schema in an isolated subprocess under the build's EFFECTIVE mode +
  // the SAME scrubbed env the build uses — still BEFORE whoami / provision / build / deploy.)

  // 3. Preflight — pin ONE transport, pin the account, confirm wrangler auth. `rootConfig` is the
  // pre-probe ground truth the post-probe laundering guard (after 3c) compares against; the ONLY
  // re-parses are the account discovery's (3b) and the email step's (3b-ii), both of which write
  // BEFORE any project code runs.
  const preflightCloudflareWorkerResult = await preflightCloudflareWorker({
    configPath,
    needsSandbox,
    voidConfig,
    root,
    exit,
    deps,
    options,
    initialCloudflareLink,
    needsEmail,
    emailHandlers,
    authEnabled,
    needsAI,
    expectedCrons,
    desired,
    preBuildMigrations,
    provisionModule,
    reasons,
    cliLog,
    detectedFramework,
    source,
    needsLive,
  });
  const apiBaseUrl = preflightCloudflareWorkerResult.apiBaseUrl;
  const cfUploaderIsPinned = preflightCloudflareWorkerResult.cfUploaderIsPinned;
  const assertUploaderStillPinned = preflightCloudflareWorkerResult.assertUploaderStillPinned;
  const accountId = preflightCloudflareWorkerResult.accountId;
  const workersDevSubdomain = preflightCloudflareWorkerResult.workersDevSubdomain;
  const runWrangler = preflightCloudflareWorkerResult.runWrangler;
  const workerName = preflightCloudflareWorkerResult.workerName;
  const emailMap = preflightCloudflareWorkerResult.emailMap;
  const schemaFacts = preflightCloudflareWorkerResult.schemaFacts;
  const existingWorker = preflightCloudflareWorkerResult.existingWorker;
  const pinnedHandoffLink = preflightCloudflareWorkerResult.pinnedHandoffLink;
  const approvedHandoffKv = preflightCloudflareWorkerResult.approvedHandoffKv;
  const bindingIdentitySnapshot = preflightCloudflareWorkerResult.bindingIdentitySnapshot;
  const passthroughIdentitySnapshot = preflightCloudflareWorkerResult.passthroughIdentitySnapshot;
  const passthroughRawFields = preflightCloudflareWorkerResult.passthroughRawFields;
  const expectedContainers = preflightCloudflareWorkerResult.expectedContainers;
  const expectedDurableObjectState = preflightCloudflareWorkerResult.expectedDurableObjectState;

  // (The LOCAL migration gates run POST-build at step 8d, immediately before the remote
  // apply — not here — so they validate the exact files on disk AFTER the build. See step 8d.)

  // 7. Build with the pinned deploy transport — WITHOUT VOID_DEPLOY_PROJECT_ID — so
  // self-host ISR emits and the CF plugin merges the wrangler.jsonc real ids into
  // dist/ssr/wrangler.json. `deployChildEnv` scrubs CLOUDFLARE_ENV +
  // CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH (and pins one account + API base), so the CF
  // plugin generates the pinned TOP-LEVEL config from the CANONICAL root wrangler config,
  // not a named-env / alternate-config one whose account/name/bindings could differ.
  //
  // The build runs BEFORE the secret / auth gates: the redesign validates the REAL artifact
  // the build emits (`dist/ssr/wrangler.json` `vars` + the generated auth schema) rather than
  // predicting it, so a missing secret / bad auth schema is caught AFTER the build — the
  // accepted trade-off for reading ground truth. No REMOTE mutation has happened yet (provision
  // ran earlier, but the remote D1 apply + deploy are still ahead), so a failed gate below
  // never leaves a half-migrated / half-deployed account.
  //
  // DELETE the CF plugin's deploy pointer (`.wrangler/deploy/config.json`) FIRST. The
  // plugin OVERWRITES it (never deletes) on each build, but ONLY when the CF Vite plugin
  // participates — a build that emits no worker artifact leaves a STALE pointer from a
  // previous run in place, and a bare `wrangler deploy` would follow it to an old
  // `dist/ssr/wrangler.json`. Removing it now means the reads below (which require the
  // pointer to exist) can only pass on a pointer THIS build re-created.
  removeDeployPointer(root);
  // `vite build` runs arbitrary project code — the user's config, every plugin, and env.ts
  // — and needs NO Cloudflare credential of its own (the CF plugin makes no authenticated
  // call from a build hook; Void's `remote: true` is a serve-only proxy to Void's own
  // platform, and build-time prerender/ISR runs on local Miniflare). So the build child gets
  // the same credential scrub as the probes, on the same rationale.
  //
  // Not a leak this can close: the CF plugin's `config` hook `loadEnv`s the project's own
  // `CLOUDFLARE_*` dotenv keys back into the child's `process.env`. Those values are already
  // on disk and readable by the build code either way — the scrub is about the credentials
  // the PARENT holds, which the project never had.
  const buildCloudflareWorkerResult = await buildCloudflareWorker({
    accountId,
    apiBaseUrl,
    existingWorker,
    deps,
    frameworkPreset,
    voidConfig,
    root,
    exit,
    detectedFramework,
    configPath,
    workerName,
    schemaFacts,
    needsAI,
    aiBindingName,
    assertUploaderStillPinned,
    migrationsDir,
    dialect,
    atomic,
    runWrangler,
    authEnabled,
    approvedHandoffKv,
    desired,
    bindingIdentitySnapshot,
  });
  const migrations = buildCloudflareWorkerResult.migrations;
  const d1MigrateToken = buildCloudflareWorkerResult.d1MigrateToken;
  const generatedConfigPath = buildCloudflareWorkerResult.generatedConfigPath;
  const prepareBuildOutput = buildCloudflareWorkerResult.prepareBuildOutput;

  // Remember whether a secret operation proved the Worker was absent before it wrote anything.
  // Wrangler creates an active placeholder version while attaching the first secret. The version
  // activator needs this proof to distinguish that placeholder from an existing application when
  // Cloudflare requires a one-time ordinary deploy for initial Durable Object migrations.
  const migrateCloudflareWorkerResult = await migrateCloudflareWorker({
    authEnabled,
    deps,
    root,
    accountId,
    workerName,
    desired,
    bindingIdentitySnapshot,
    passthroughIdentitySnapshot,
    passthroughRawFields,
    needsAI,
    aiBindingName,
    expectedContainers,
    expectedDurableObjectState,
    expectedCrons,
    exit,
    configPath,
    runWrangler,
    assertUploaderStillPinned,
    cliLog,
    dialect,
    migrations,
    migrationsDir,
    d1MigrateToken,
    schemaFacts,
  });
  const workerWasMissingBeforeSecretProvisioning =
    migrateCloudflareWorkerResult.workerWasMissingBeforeSecretProvisioning;
  const initialAuthSecret = migrateCloudflareWorkerResult.initialAuthSecret;
  const appliedMigrations = migrateCloudflareWorkerResult.appliedMigrations;

  // 11. Deploy the exact generated config verified above. Passing its absolute path
  // explicitly keeps the version upload AND the later trigger synchronization on the
  // same artifact. `versions upload` follows the deploy pointer on its own, but
  // `triggers deploy` does not; omitting `configPath` here would therefore upload the
  // generated cron/queue configuration and then synchronize triggers from the root
  // config, silently dropping generated Cron Triggers and queue consumers.
  // `--experimental-provision=false` / `--experimental-auto-create=false` disable
  // wrangler 4.131's OWN resource provisioning (both default true, deployCommand +
  // globalFlags, wrangler-dist/cli.js), so ONLY `provisionCloudflareResources` may create
  // resources — a bare deploy can never auto-create a missing binding (e.g. an R2 bucket
  // absent remotely but passing the local drift predicate), even in CI.
  // `--autoconfig=false` disables wrangler 4.131's framework detection + auto-config
  // (`autoconfig` defaults true, deployCommand cli.js:283108). Without it, a detected
  // framework marker (e.g. OpenNext) can make wrangler DELEGATE the deploy to another tool
  // (`maybeDelegateToOpenNextDeployCommand`, cli.js:282991) — which
  // would upload something OTHER than the artifact Void just built and verified. Forcing it
  // off guarantees wrangler uploads exactly the verified `dist/ssr/wrangler.json`.
  //
  // Final uploader re-verification immediately before the deploy — the last and most privileged
  // credentialed run of the hashed bundle. Against the same pre-build baseline; fail closed.
  await publishCloudflareWorker({
    configPath,
    existingWorker,
    root,
    pinnedHandoffLink,
    initialCloudflareCandidate,
    accountId,
    workerName,
    deps,
    cfUploaderIsPinned,
    exit,
    prepareBuildOutput,
    apiBaseUrl,
    runWrangler,
    generatedConfigPath,
    assertUploaderStillPinned,
    schemaFacts,
    initialAuthSecret,
    approvedHandoffKv,
    migrations,
    workerWasMissingBeforeSecretProvisioning,
    workersDevSubdomain,
    atomic,
    cliLog,
    needsSandbox,
    appliedMigrations,
    d1MigrateToken,
    source,
    desired,
    detectedFramework,
  });
  // The address map — the one thing nobody can find today (0078). Printed whenever the worker
  // shipped with email set up; a run that went without email already said so at 3b-ii.
  if (emailMap) {
    log.message(renderAddressMap(emailMap));
  }
  printDeploySuccess();
}

/**
 * Discover the root wrangler config path the same way the build / bindings
 * writer do (wrangler.jsonc first, then wrangler.json). Falls back to the
 * default wrangler.jsonc path when none exists yet — the provisioner creates it.
 */
export function discoverRootWranglerConfig(root: string): string {
  if (existsSync(join(root, 'wrangler.toml'))) {
    throw new Error(
      'Found wrangler.toml. Direct Cloudflare deployment needs one root wrangler.jsonc or wrangler.json with the same settings. Convert the config before deploying.',
    );
  }
  return materializeCloudflareConfig(root);
}

export async function reportCloudflareActivationFailure(
  cliLog: CliLogger,
  message: string,
): Promise<void> {
  cliLog.error('cloudflare_deploy_failed', new Error(message));
  // The default exit() terminates the process immediately, so flush the diagnostic first.
  await cliLog.close().catch(() => {});
  log.error(`${message}${cliLog.path ? `\n\nDetailed log: ${cliLog.path}` : ''}`);
}

export async function activateCloudflareVersionWithProgress(
  activate: typeof activateCloudflareVersion,
  options: Parameters<typeof activateCloudflareVersion>[0],
): ReturnType<typeof activateCloudflareVersion> {
  const progress = createSpinner();
  progress.start('Checking the current Worker deployment...');
  try {
    const result = await activate({
      ...options,
      onProgress: (message) => progress.message(message),
    });
    if (result.ok) {
      progress.clear();
    } else {
      progress.error('Worker deployment stopped.');
    }
    return result;
  } catch (error) {
    progress.error('Worker deployment stopped.');
    throw error;
  }
}

export function formatCloudflareActivationError(
  result: Exclude<Awaited<ReturnType<typeof activateCloudflareVersion>>, { ok: true }>,
): string {
  const status = result.status === undefined ? '' : ` (exit ${String(result.status)})`;
  const cloudflareCode =
    result.cloudflareErrorCode === undefined
      ? ''
      : ` Cloudflare error code: ${String(result.cloudflareErrorCode)}.`;
  const diagnostic = result.diagnostic ? `\n\n${result.diagnostic}` : '';
  switch (result.reason) {
    case 'uploader-changed':
      if (result.rollback === 'succeeded') {
        return 'deploy: the verified Wrangler uploader changed after version activation. Traffic was restored to the previous version.';
      }
      if (result.rollback === 'unavailable') {
        return 'deploy: the verified Wrangler uploader changed after the first version activated. No previous version is available; inspect `void project status` immediately.';
      }
      if (result.rollback === 'failed') {
        return 'deploy: the verified Wrangler uploader changed after version activation, and automatic traffic restoration failed. Inspect `void project status` immediately.';
      }
      if (result.rollback === 'unsafe') {
        return 'deploy: the verified Wrangler uploader changed after version activation. Void did not invoke the changed binary to restore traffic; reinstall Wrangler from a trusted lockfile and inspect `void project status` immediately.';
      }
      return 'deploy: the verified Wrangler uploader changed before version activation.';
    case 'status-failed':
      if (result.versionId) {
        return `deploy: Worker version ${result.versionId} was published, but current deployment status could not be verified${status}. Inspect \`void project status\` before retrying.`;
      }
      return `deploy: could not snapshot the current Cloudflare deployment${status}; no version was uploaded.`;
    case 'deployment-changed':
      return result.triggerRepair === 'succeeded'
        ? `deploy: another Cloudflare operation superseded this deployment. Void restored triggers for the active version ${result.activeVersionId ?? '(unknown)'}; retry from fresh deployment status.`
        : `deploy: another Cloudflare operation superseded this deployment, but its trigger state could not be verified. Inspect the active Worker version ${result.activeVersionId ?? '(unknown)'} immediately.`;
    case 'inheritance-source-unavailable':
      return 'deploy: could not verify which Worker Version would supply inherited secrets; production traffic is unchanged.';
    case 'inheritance-source-changed':
      return [
        'deploy: the active Worker Version is not the latest upload, and its secrets could not be pinned safely.',
        'Inspect the active and latest Worker versions in Cloudflare before retrying.',
        'No version was uploaded; production traffic is unchanged.',
      ].join('\n');
    case 'traffic-preservation-unavailable':
      return [
        'deploy: the existing Worker has dashboard-managed routes or visibility that Void cannot safely republish.',
        'Add its current routes, workers_dev, and preview_urls values to the root Wrangler config, then retry; no version was uploaded.',
      ].join('\n');
    case 'traffic-split-unsupported':
      return [
        'deploy: the current Cloudflare deployment splits traffic across multiple Worker Versions.',
        'Void will not flatten an existing gradual rollout to 100%. Finish or cancel that rollout',
        'in Cloudflare, then retry; no version was uploaded.',
      ].join('\n');
    case 'upload-failed':
      return `deploy: Cloudflare Worker Version upload failed${status}; production traffic is unchanged.${cloudflareCode}${diagnostic}`;
    case 'upload-output-invalid':
      return 'deploy: Wrangler uploaded a version but did not report its version id; production traffic is unchanged.';
    case 'preview-unavailable':
      if (result.diagnostic) {
        return `deploy: candidate readiness cannot be verified.\n\n${result.diagnostic}`;
      }
      return [
        'deploy: the uploaded Worker Version has no preview URL, so Void cannot verify readiness.',
        'Set CLOUDFLARE_WORKERS_SUBDOMAIN to your account subdomain (for example "my-team")',
        'and retry. Void caches it after a successful workers.dev deployment; production traffic is unchanged.',
      ].join('\n');
    case 'readiness-staging-failed':
      return `deploy: Cloudflare could not stage the uploaded Worker Version at zero-percent traffic${status}; production traffic is unchanged.${cloudflareCode}${diagnostic}${result.cloudflareErrorCode === 10210 && /Durable Object migration/i.test(result.diagnostic ?? '') ? '\n\nReview the Durable Object migration, then run `void deploy --platform cloudflare --atomic`. For future deploys, set deploy.cloudflare.mode to "atomic" in void.config.ts.' : ''}`;
    case 'atomic-failed':
      return `deploy: Cloudflare could not publish the Worker atomically${status}; inspect production status before retrying.${cloudflareCode}${diagnostic}`;
    case 'atomic-output-invalid':
      return 'deploy: Cloudflare published atomically but did not report a version id or URL. Inspect `void project status` immediately.';
    case 'atomic-readiness-failed':
    case 'atomic-readiness-access-denied':
      return `deploy: the atomic Worker deployment is live, but /__void/ready could not be verified. Inspect \`void project status\` and Worker logs immediately.${diagnostic}`;
    case 'readiness-failed':
      return [
        'deploy: the uploaded Worker Version did not pass /__void/ready.',
        formatCloudflareReadinessRestoration(result),
      ].join('\n');
    case 'readiness-access-denied':
      return [
        'deploy: Cloudflare Access blocked the uploaded Worker Version readiness probe.',
        'For CI, set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET to an admitted service token.',
        'For a local deploy, set CF_ACCESS_TOKEN to a short-lived user JWT from cloudflared.',
        'If the response is error 1050, create an Access application for this hostname; a token alone cannot bypass account default-deny.',
        `Then retry. ${formatCloudflareReadinessRestoration(result)}`,
      ].join('\n');
    case 'bootstrap-failed':
      return `deploy: Cloudflare could not bootstrap the first Worker deployment${status}.${cloudflareCode}${diagnostic}`;
    case 'bootstrap-output-invalid':
      return [
        'deploy: Cloudflare bootstrapped the first Worker deployment, but Wrangler',
        'did not report its version id and workers.dev URL. Inspect `void project status` before retrying.',
      ].join('\n');
    case 'bootstrap-readiness-failed':
      return (
        [
          'deploy: the first Worker deployment did not pass /__void/ready.',
          'Cloudflare requires this bootstrap to be non-versioned, so the new Worker is already active;',
          'inspect its logs and `void project status` before retrying.',
        ].join('\n') + diagnostic
      );
    case 'bootstrap-readiness-access-denied':
      return [
        'deploy: Cloudflare Access blocked the first Worker deployment readiness probe.',
        'For CI, set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET to an admitted service token;',
        'for a local deploy, set CF_ACCESS_TOKEN to a short-lived user JWT from cloudflared.',
        'If the response is error 1050, create an Access application for this hostname; a token alone cannot bypass account default-deny.',
        'Then retry. Cloudflare requires the first deployment to be non-versioned, so the new',
        'Worker is already active behind Access.',
      ].join('\n');
    case 'activation-failed':
      return `deploy: the ready Worker Version could not be activated${status}; production traffic is unchanged.`;
    case 'triggers-failed': {
      const rollback =
        result.rollback === 'succeeded'
          ? 'Traffic was restored to the previous version.'
          : result.rollback === 'unavailable'
            ? result.previousVersionId === null
              ? 'This was the first deployment, so no previous version was available to restore.'
              : 'Traffic or trigger restoration could not be completed. Inspect its routes, schedules, queues, and workflows in Cloudflare before retrying.'
            : 'Automatic traffic restoration failed; inspect `void project status` immediately.';
      return `deploy: the Worker activated, but Cloudflare trigger synchronization failed${status}. ${rollback}`;
    }
  }
}

function formatCloudflareReadinessRestoration(
  result: Exclude<Awaited<ReturnType<typeof activateCloudflareVersion>>, { ok: true }>,
): string {
  switch (result.rollback) {
    case 'succeeded':
      return 'The failed version remains inactive, and traffic was restored to the previous version.';
    case 'failed':
      return 'Automatic traffic restoration failed; inspect `void project status` immediately.';
    case 'unsafe':
      return 'Void did not invoke the changed Wrangler binary to restore traffic; reinstall Wrangler from a trusted lockfile and inspect `void project status` immediately.';
    case 'unavailable':
      return 'No previous version was available to restore; inspect `void project status` immediately.';
    default:
      return 'The failed version remains inactive for inspection; production traffic is unchanged.';
  }
}

/** Capture the Access credential used only by the guarded Worker readiness probe. */
export function cloudflareWorkerReadinessHeaders(): Record<string, string> {
  return trustedCloudflareWorkerAccessHeaders({
    CF_ACCESS_CLIENT_ID: process.env.CF_ACCESS_CLIENT_ID,
    CF_ACCESS_CLIENT_SECRET: process.env.CF_ACCESS_CLIENT_SECRET,
    CF_ACCESS_TOKEN: process.env.CF_ACCESS_TOKEN,
  });
}
