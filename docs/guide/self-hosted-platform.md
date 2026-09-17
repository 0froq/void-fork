---
outline: deep
---

# Install a Void Platform

A Void platform lets your team deploy apps into a shared Cloudflare account. As an administrator, you install and maintain the platform. Developers connect the Void CLI to its URL, sign in with GitHub, and deploy their apps.

If you're deploying an app for yourself, [deploy directly to Cloudflare](../integrations/cloudflare.md#deploy-to-your-own-cloudflare-account). You don't need to install a platform first.

The core platform supports GitHub login, CLI deploys, D1, KV, R2, Queues, cron jobs, Workers AI, WebSockets, SSE, ISR, routing, logs, and rollback. It uses the same components as Void Cloud.

The user dashboard, GitHub builds and webhooks, build Containers, email, Google login, custom project domains, and sandbox orchestration aren't part of the core installation.

## Before You Start {#prerequisites}

Start with a Cloudflare account you can administer, a GitHub account, and an empty hosted PostgreSQL database. A domain is recommended. If yours is not ready, choose **Use workers.dev for testing** during installation and [add a domain later](#add-a-domain-later). The steps below explain how to get the credentials the installer asks for.

Void creates the Workers, storage, queues, routing, and database tables. You do not need to create those resources yourself, install a separate deployment tool, or clone this repository.

This setup has costs: Workers for Platforms requires a paid plan, and your database and Cloudflare usage have their own pricing. External PostgreSQL is required in either mode. Native single-app deployments remain Workers Free-compatible unless the app uses a paid-only product.

## 1. Prepare Your Cloudflare Account and Domain

In the [Cloudflare dashboard](https://dash.cloudflare.com/), select the account where you want the platform to live:

1. Open **Workers & Pages**, finish onboarding, and choose the account's `workers.dev` subdomain.
2. Open **Workers for Platforms** and enable its plan. Review [Workers for Platforms pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/platform/pricing/) before confirming.
3. Open **R2 Object Storage** and complete its activation. Void creates the bucket later.
4. For a domain installation, choose a domain you own, such as `example.app`. If you need one, register it with your preferred registrar. Use a spare domain's root: apps will be served at `my-app.example.app`. For workers.dev testing, skip this step and the DNS setup below.

If Workers & Pages already shows a **Subdomain** in the account details, that setup is complete even when the account has no Workers. You do not need to create a placeholder Worker. If Void cannot read an existing subdomain, retry and check the reported API status or account permissions.

If that domain is already in this Cloudflare account, use its existing zone. Otherwise, [add the domain to Cloudflare](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/) and follow the nameserver instructions until the zone is active. A zone is Cloudflare's DNS configuration for a domain; creating one does not buy the domain.

You can also let Void create the zone during installation. Setting it up now lets you scope the API tokens to that zone and finish installation without a DNS pause. The platform API uses `workers.dev` by default, so it needs no additional domain.

## 2. Install the CLI and Preview {#preview-the-installation}

With Node.js 24.21.0 or later, install the CLI:

```sh
pnpm add --global void
void platform install --plan
```

The plan command opens Cloudflare browser login when needed. It asks for the account and basic configuration, then shows the resources it would create. It does not require the database or runtime secrets and does not change Cloudflare resources.

The installer first offers these choices, with the domain option selected:

```text
Where should your apps live?
  Use a domain — recommended
  Use workers.dev for testing — add a domain later
```

For a domain installation, use these answers. Testing mode skips the application domain, zone, and catch-all questions:

| Prompt                                  | Answer                                              |
| --------------------------------------- | --------------------------------------------------- |
| Installation name                       | A short name, such as `team`                        |
| Application base domain                 | Your domain, such as `example.app`                  |
| Cloudflare zone                         | The same domain                                     |
| Platform display name                   | Any name your team will recognize                   |
| Optional custom API hostname            | Leave empty to use `workers.dev`                    |
| Dedicate all unmatched traffic to Void? | Yes only if this whole zone belongs to the platform |

The preview uses placeholder resource names. The real install prints its final names and GitHub callback URL.

You can select either path directly:

```sh
void platform install --application-domain example.app --plan
void platform install --workers-dev --plan
```

`--workers-dev` cannot be combined with `--application-domain`, `--zone`, or `--dedicated-zone`.

::: tip Working from this repository?
Run `vpr install:void-dev` and use `void-dev` wherever this guide says `void`. Add `--runtime packages/platform/dist/runtime` to install, resume, and upgrade commands from the repository root to select your source build. No source-revision environment variable is needed. See [Platform Development](./platform-development.md).
:::

## 3. Create the Platform Database

Use an empty PostgreSQL database dedicated to this platform. It stores users, projects, and deployments; individual apps can still use D1. Void creates the tables and the Hyperdrive connection, but does not provision the PostgreSQL server.

If you already have hosted PostgreSQL, create a fresh database and a user that owns it. The connection must work both from your computer, for migrations, and from Cloudflare, for the running platform.

For example, with [Neon](https://neon.com/):

1. Create a new project for the platform.
2. Open its connection details and select the new database and its owner role.
3. Turn **connection pooling off** and copy the PostgreSQL connection URL, including the password and SSL settings, into your password manager. Copy only the URL, not a surrounding `psql` command.

The direct connection is needed for installation locks and migrations. Cloudflare also recommends it for [Neon with Hyperdrive](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/neon/). You will paste it into Void's `PostgreSQL DATABASE_URL` prompt.

Once installation claims the database, continue using that same database for resume and maintenance commands. Uninstall never deletes external PostgreSQL.

## 4. Prepare Credentials

Keep one password-manager entry for this platform. Paste the saved values into the installer when asked; most do not need shell environment variables.

### Cloudflare API Tokens {#runtime-token-permissions}

For a domain installation, create two custom tokens using Cloudflare's [API token setup](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/). Name them **Void Platform Management** and **Void Platform Runtime**. Scope them to your selected account and application zone.

For workers.dev testing with the default API hostname, browser login can authorize installation: you only need to create the runtime token and R2 credentials below. Skip the zone permissions until you add a domain.

The management token lets your CLI install and maintain the platform. The runtime token is stored as a Worker secret so the platform can deploy apps after you close your terminal. They are separate credentials.

::: details Permissions to select for each token

Use the following permissions for the core platform. Cloudflare may label write access as **Edit** or **Write**, depending on the token screen; see its [permission reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).

| Scope   | Permission         | Management | Runtime |
| ------- | ------------------ | ---------- | ------- |
| Account | Account Settings   | Read       | Read    |
| Account | Workers Scripts    | Edit       | Edit    |
| Account | Workers Tail       | Read       | Read    |
| Account | D1                 | Edit       | Edit    |
| Account | Workers KV Storage | Edit       | Edit    |
| Account | Workers R2 Storage | Edit       | Edit    |
| Account | Queues             | Edit       | Edit    |
| Account | Hyperdrive         | Write      | Write   |
| Account | Account Analytics  | Read       | Read    |
| Account | AI Gateway         | Edit       | —       |
| Zone    | Zone               | Read       | —       |
| Zone    | DNS                | Edit       | —       |
| Zone    | Workers Routes     | Edit       | —       |
| Zone    | Cache Purge        | —          | Purge   |

The management token also needs **Zone Edit** with authority to create zones if you ask Void to create the zone. If it already exists, use the selected zone with Zone Read and DNS Edit. Nested application domains additionally need **SSL and Certificates: Read** on the management token. A custom runtime that enables custom project domains needs **SSL and Certificates: Edit** on the runtime token; the core runtime does not enable that feature.

Void checks account and Hyperdrive access before provisioning. For an existing zone it verifies Cache Purge by purging one unique nonexistent URL, without logging the token or URL. This preflight cannot prove every write permission; a later permission error names the operation to check.

:::

### R2 Upload Credentials

In the account's **R2 Object Storage** page, select **Manage API Tokens**, create an account token if your role permits it (otherwise a user token), and choose **Object Read & Write**. The installer needs these credentials before creating its bucket, so the initial token must cover that bucket when it is created; the dashboard's all-buckets option covers it. Save the **Access Key ID** and **Secret Access Key**. These are different from the two management/runtime tokens above. See [R2's token instructions](https://developers.cloudflare.com/r2/api/tokens/).

### Signing and Encryption Keys

The current installer asks for two keys. Generate and save them before continuing: a JWT signing secret with at least 32 random bytes, and a separate project-encryption key containing exactly 32 random bytes encoded as base64. Generate each once per platform and keep the originals for recovery.

::: details Generate the keys without printing them to your terminal

On macOS, this copies a suitable random value to the clipboard:

```sh
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))' | pbcopy
```

Paste it into your password manager as **JWT signing secret**. Run the command again and save the second value as **Project encryption key**. On PowerShell, use `Set-Clipboard` instead of `pbcopy`; on other systems, use your secret manager's secure generator with the same byte length and encoding.

:::

## 5. Install and Connect GitHub {#install}

For workers.dev testing, start the interactive install and continue to the GitHub setup below:

```sh
void platform install --workers-dev
```

For a domain installation, the management token is the one value the interactive installer needs in the shell. Browser login cannot create the application's DNS record. In Bash or zsh, read the token without displaying it or putting its value in command history:

```sh
printf 'Cloudflare management API token: '
read -rs CLOUDFLARE_API_TOKEN
printf '\n'
export CLOUDFLARE_API_TOKEN
void platform install
```

::: details PowerShell equivalent

```powershell
$env:CLOUDFLARE_API_TOKEN = [System.Net.NetworkCredential]::new('', (Read-Host 'Cloudflare management API token' -AsSecureString)).Password
void platform install
```

:::

Use the same name, account, and domain as the preview. The command shows the final plan, API URL, and callback URL, then waits for confirmation. Leave that terminal open while you configure GitHub.

### Configure GitHub OAuth {#configure-github-oauth}

1. Open [GitHub's new OAuth App form](https://github.com/settings/applications/new) while signed in as the account that will own the login integration.
2. Set **Application name** to your platform's display name and **Homepage URL** to the API URL Void just printed.
3. Set **Authorization callback URL** to the exact printed URL ending in `/auth/callback`, then register the application. Use the real install's URL, not the earlier preview's placeholder.
4. Save the **Client ID**, generate a **Client Secret**, and save that too. GitHub's [registration guide](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) describes the form.

This OAuth App handles sign-in. A GitHub App with repository access and build webhooks is not required for the core platform.

Back in the terminal, confirm the plan and answer the prompts in order: runtime Cloudflare token, your initial administrator's GitHub username, PostgreSQL URL, GitHub client ID and secret, signing and encryption keys, and R2 credentials. Secret values are masked.

Void applies database migrations, provisions the resources, deploys the Workers, and verifies the platform. Installation progress is checkpointed for recovery. When it prints the installed API URL, continue to [connect and deploy an app](#connect-and-deploy-an-app).

Remove the management token from the shell when finished:

```sh
unset CLOUDFLARE_API_TOKEN
```

In PowerShell, use `Remove-Item Env:CLOUDFLARE_API_TOKEN`. Keep the saved token for future maintenance.

::: details If setup pauses for DNS or is interrupted

If Void created a zone, it stops in `waiting-for-dns` and prints nameservers. Set those at your registrar, wait for the zone to become active, then resume using the installation ID printed by Void:

```sh
void platform install --resume --name <installation-id>
```

Keep the management token available for any remaining DNS changes. When using a source build, also pass the same `--runtime` directory. Resume uses the saved checkpoint and original secrets; do not start a second installation or generate replacement keys. If setup failed before a checkpoint was saved, rerun the original command.

:::

## 6. Verify and Deploy Your First App {#connect-and-deploy-an-app}

First verify the new platform and sign in as the GitHub administrator you chose:

```sh
void platform status
void platform auth login
void platform system health
```

Administrator login is separate from the credentials used to deploy apps. In a new or unlinked Void app directory, connect using the installed API URL and deploy your first project:

```sh
void connect https://void-company-api.example.workers.dev
void deploy --platform void --project my-first-app
```

`void connect` validates the platform and signs you in when needed. Confirm project creation when deploy asks. To use a project that already exists, run `void project link` instead. An app already linked to another platform keeps its existing destination; use a fresh app directory for your first test.

The CLI stores login credentials in your system keychain, separately for each platform URL. With no URL, `void connect` offers Cloudflare or a Void platform; `void connect --platform void` offers saved platforms and an option to enter another URL.

In CI, use `void connect <url> --no-login` to register the platform, and supply `VOID_TOKEN` and `VOID_API_URL` for deployment. To verify authentication during connection, omit `--no-login` and set both variables to credentials for that same platform. Older project files already linked to Void Cloud continue to work.

Use these commands to inspect connections and installations:

```sh
void platform list
void platform use [id]
void platform status [id]
```

## Managing Access

After installation, sign in with the GitHub account you chose as the first administrator:

```sh
void platform auth login
void platform signup allow github teammate
```

Void shows the proposed access change and asks you to confirm it. Once approved, `teammate` can connect to the platform's API URL and sign in with GitHub.

To see who can join, run `void platform signup show`. You can also allow an email address or a domain such as `*@example.com`. `void platform signup open` permits public signup; `void platform signup restrict` requires an allowlist match again.

Your administrator session lasts for one hour. Use it to inspect users, projects, logs, and platform health. The [Platform Administration guide](./platform-administration.md) walks through those workflows, previews, and automation. You can also open `<API origin>/admin/login` to use the browser admin UI.

## Add a Domain Later

When your domain is ready, run:

```sh
void platform domain set example.app --plan
void platform domain set example.app
```

The command selects your installed platform (or offers a picker), finds or creates its zone, sets up DNS and routing, and verifies HTTPS before publishing the new application URLs. Set the management token as described [above](#install) when creating DNS or a zone. Grant the existing runtime token **Cache Purge: Purge** on the new zone; Void checks that permission through the running platform without asking you to paste its token again.

If nameservers or certificates are pending, follow the printed guidance and rerun the same command. Your workers.dev app URLs continue working during and after setup. Projects, deployments, secrets, and the platform API URL stay the same, so developers do not reconnect and the platform's GitHub OAuth callback does not change. DNS and configuration changes may take time to propagate.

Use `--installation <id>` to select an installation explicitly, `--zone example.com` for an app domain such as `apps.example.com`, or `--dedicated-zone` for catch-all routing on a dedicated zone. Nested domains still need the wildcard certificate described below. This command adds the first domain; replacing an existing application domain is not currently supported. It uses the installed runtime and does not require `--runtime` or an app redeploy.

Browser login sessions are specific to each origin. Apps using their own OAuth providers may need to register their new callback URLs. Void's built-in auth uses the request origin automatically unless the app overrides that configuration.

### What Changes in Testing Mode?

Each deployed app gets a small forwarding Worker and its own `workers.dev` origin. It forwards requests, including WebSockets and SSE, through the same platform router. Names include installation and project IDs; a later project with the same slug cannot inherit a deleted project's test URL.

Testing origins use shared ISR storage but bypass the extra edge response cache because you cannot use your zone's purge API for `workers.dev`. Custom-domain requests use the normal edge cache after activation. Existing test URLs and forwarding Workers are retained when you add a domain; new apps then use the domain without creating more forwarding Workers. Like other platform Workers, forwarders are retained for manual cleanup on uninstall; platform disablement and project suspension still apply to their traffic.

## Other Domain Options

::: details Custom API hostname

Pass `--control-plane-domain platform.example.net` during installation. The hostname must belong to a zone the selected account and management token can manage. Omitting it keeps the API on `workers.dev`.

:::

### Using a Nested Application Domain

::: details Use apps.example.com within an existing company zone

An app at `my-app.apps.example.com` needs a certificate for `*.apps.example.com`. Universal SSL for `example.com` only covers first-level hostnames. Configure an active wildcard certificate with [Advanced Certificate Manager](https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/), a paid add-on, or use an existing custom wildcard certificate before installation:

```sh
void platform install --application-domain apps.example.com --zone example.com --plan
```

The management token needs **SSL and Certificates: Read** (or Edit) on that zone for the certificate check. Void does not order certificates or enable paid products automatically. Leave `--dedicated-zone` off: that flag is only for installations whose application domain is the entire zone and adds catch-all routes for otherwise unmatched traffic.

:::

## Cloudflare footprint

Resources use a `void-<installation-name>-<random-suffix>-*` prefix where Cloudflare allows names. This keeps installations recognizable and avoids predictable Worker names colliding during setup.

| Resource                                  |                                 Count | Purpose                                                                        |
| ----------------------------------------- | ------------------------------------: | ------------------------------------------------------------------------------ |
| Workers                                   | 4, plus one per app using workers.dev | API/control plane, proxy, tail ingestion, dispatch, and test-origin forwarders |
| KV namespaces                             |                                     3 | Routing, ISR cache, and legacy/static asset compatibility                      |
| R2 buckets                                |                                     1 | Static and deployment assets                                                   |
| Queues                                    |                                     2 | Usage events and cron firing                                                   |
| Workers for Platforms dispatch namespaces |                                     1 | User application Workers                                                       |
| Hyperdrive configurations                 |                                     1 | External platform PostgreSQL                                                   |
| AI Gateways                               |                                     1 | Installation-isolated AI routing and metering                                  |
| Proxied wildcard DNS records              |                                0 or 1 | Created only when an application domain is configured                          |
| Zones                                     |                                0 or 1 | Created only when the requested application zone is absent                     |

The API Worker uses four Durable Object classes for usage, cron scheduling, error monitoring, and concurrency. Worker bindings create the request and log datasets in Analytics Engine. The core installation doesn't create Container applications, a GitHub App, a dashboard Worker, or build Workers.

## Resume, repair, recover, and upgrade

You can omit an installation ID when only one is configured. With several installations, choose one interactively or pass its ID in CI.

### Resume an installation

If setup stops or fails, continue from the saved progress:

```sh
void platform install --resume --name <id>
```

You can correct the database URL if the initial connection failed. Once Void has claimed the database or provisioned Hyperdrive, that database is fixed for the installation. A later command with a different URL stops before making changes.

### Repair missing resources

Preview what needs repair, then apply it:

```sh
void platform repair [id] --plan
void platform repair [id]
```

Repair recreates missing infrastructure that the installer owns. It does not restore PostgreSQL rows or data stored in provider resources. If an adopted or external resource is missing, restore it yourself before continuing. A disabled platform stays disabled through repair and upgrade.

### Upgrade the platform

Use the installed CLI's packaged runtime to upgrade:

```sh
void platform upgrade [id] --plan
void platform upgrade [id]
```

An upgrade validates the runtime, applies supported pending migrations, deploys the Workers, and checks their health. Existing Worker secrets are preserved.

::: details Migration safety, credential rotation, and interrupted upgrades

When a release changes the authenticated usage protocol shared by the platform Workers, the installer briefly puts the platform into maintenance mode before updating the first Worker. It restores traffic only after the API reports the target protocol and every Worker version in the runtime has been verified. If the command is interrupted, traffic stays blocked; rerun the same upgrade to resume. The installer never opens a compatibility window for unsigned usage messages.

To update the runtime Cloudflare token, GitHub OAuth credentials, or R2 credentials,
provide their `VOID_PLATFORM_*` environment variables when running the upgrade.
Only the supplied values replace live credentials. Recovery data from an older
workstation does not overwrite them, and upgrades preserve the live signing keys
and complete project-encryption keyring. Keep current credentials in your secret
manager so they can also restore a missing Worker during repair.

Database migrations only move forward. Void checks that the live migration history matches the release's files and order. If migrations are pending, the release must explicitly support running the previous Worker version against the updated schema. Otherwise, upgrade stops and asks you to use an intermediate release.

Pending migrations run in one PostgreSQL transaction. If the Worker rollout fails, Void restores the previous Workers against that compatible schema. A retry recognizes migrations that already succeeded.

The first upgrade to the Sandbox drain safety protocol is a two-stage cutover when the database contains deployments or container resources. Before accepting an empty inventory, Void transactionally closes legacy deployment admission. Requests already inserting a deployment finish and become visible to the drain; older Workers that try afterward are rejected by the database. Void then deploys and verifies the compatible candidate runtime in `sandbox-drain` maintenance mode, leaves application traffic closed, and trusts only its authenticated, database-backed status. An empty fresh installation records a completed checkpoint without making Container API calls. A disabled legacy installation records the protocol floor and pending drain before its upgrade completes, so later enablement still enters maintenance.

The standard operator login, session elevation, CLI token minting, and logout flows remain available through an exact method-and-path allowlist and keep their normal authentication checks. Application and deployment routes remain closed throughout the drain.

Preview bounded drain pages with `void platform system sandbox-drain --plan`, pass each returned `nextCursor` with `--cursor '<value>'`, then apply with `void platform system sandbox-drain --yes` and rerun until it reports `complete: true`. Rerun the interrupted lifecycle command afterward; Void verifies the completion checkpoint before enabling traffic. Never delete an unverified container application by name.

After a successful upgrade, you can restore a declared-compatible earlier runtime without reversing migrations:

```sh
void platform rollback [id] --runtime /path/to/earlier/runtime --plan
void platform rollback [id] --runtime /path/to/earlier/runtime
```

The installed packaged runtime provides the compatibility declaration. If the current installation used a custom build, also pass its exact artifact directory with `--from-runtime /path/to/current/runtime`. Void compares the current manifest digest with the installed checkpoint, requires the earlier migration journal to be an exact prefix, and verifies PostgreSQL remains at the current forward-only schema. Discovery on another machine preserves the running-runtime and database-schema provenance independently, so a normal `upgrade` can roll forward later. A target missing a safety protocol already required by the database, such as completed Sandbox drain, is rejected before any Worker upload.

:::

### Manage an installation from another machine

Use `discover` to restore the administrator's local installation records:

```sh
void platform discover --account <account-id> --installation <id-or-name>
```

Discovery checks the recorded resources and their ownership before saving local state. For a healthy enabled installation, it also checks the live platform's identity. If an installer-owned resource is missing, discovery restores the verified installation record without requiring its endpoint to respond; run `void platform repair [id]` next to recreate the resource. Discovery refuses a same-name replacement or any surviving resource whose ownership marker belongs to another installation. Interrupted or disabled installations can also be recovered when their endpoints are unavailable.

After discovery, provide `VOID_PLATFORM_DATABASE_URL` for migrations and to coordinate administrator commands. You don't need to re-enter the other secrets for a normal upgrade. If repair must recreate a missing API or proxy Worker, supply its original runtime token, GitHub, R2, JWT, and project-encryption secrets through the `VOID_PLATFORM_*` variables. Cloudflare can't return those values, so keep them in your organization's secret manager.

For an installation whose project-secret keyring is still the original `v1` key, `VOID_PLATFORM_PROJECT_SECRET_KEY` remains the simple restore input. After rotating that keyring, instead supply both `VOID_PLATFORM_PROJECT_SECRET_KEYS_JSON` and `VOID_PLATFORM_PROJECT_SECRET_ACTIVE_KEY_VERSION`. The JSON object must include every key version still needed to decrypt stored project secrets, and the active version must name one of those entries. Repair validates this pair and keeps its local copy only in the encrypted recovery checkpoint. It uses the pair when recreating a missing API Worker; it does not replace the live keyring during a normal upgrade or when the API Worker already exists. Inject these values directly from a secret manager without printing them or writing a plaintext secrets file.

### Prepare for disaster recovery

`discover` reconstructs verified installation metadata on another machine. It does not download credentials, key material, or backed-up data. `repair` can then recreate missing installer-owned infrastructure, but it does not recover the data that infrastructure previously held.

Keep a coordinated recovery set for each installation:

- a PostgreSQL backup;
- the installation identity—the JWT signing secret and complete project-encryption keyring—in a secret manager;
- provider-supported backups or exports for every data-bearing provider resource;
- the immutable runtime artifacts and manifest for the installed version or custom source revision.

Capture and label these items as one recovery point so PostgreSQL, provider data, identity, and encryption keys match. Backup and retention capabilities vary by provider and resource; choose and test the supported recovery process for each resource you use.

During a restore, keep platform and application traffic disabled before changing resources. Restore the matching PostgreSQL and provider data with their supported recovery tools, supply the original identity and keyring, and use the preserved runtime artifact. Then run `discover`, preview `repair` with `--plan`, and review every ownership decision and proposed resource change before applying it. Enable traffic only after the restored data and platform health have been verified. Discovery and repair are not substitutes for those backups and do not provide a recovery bypass when required secrets or data are unavailable.

### Where local state lives

Installation records live in `~/.void/platforms/` and contain no credentials. Recovery secrets are encrypted with AES-256-GCM in `.recovery.enc` files. The encryption key lives in your operating system's keychain; on systems with POSIX permissions, recovery files are readable only by their owner. Older plaintext `.recovery` files are encrypted and removed on first read.

If the keychain isn't available, Void stops before writing secrets. Headless environments can supply `VOID_PLATFORM_RECOVERY_KEY`: a canonical base64-encoded 32-byte key from a secret manager. A temporary CI runner can use a new recovery-encryption key for each run only when every original credential remains available in protected CI secrets, including `VOID_PLATFORM_JWT_SECRET` and either the original `VOID_PLATFORM_PROJECT_SECRET_KEY` or the complete rotated keyring and active-version pair.

::: details How recovery protects existing resources

Platform commands hold a PostgreSQL advisory lock so two administrators can't change the same installation at once. The database also stores the authoritative installation record; stale local or KV records cannot overwrite newer changes.

Before migrations or uploads, Void checks that Hyperdrive still points at the recorded database, including its scheme, host, port, database name, and user when Cloudflare provides it. The recorded fingerprint excludes the password. A changed origin stops the operation.

New, resumed, and previously disabled installations block user traffic before Worker uploads begin. Upgrades also block traffic when the runtime changes its authenticated usage protocol. Only the installer's health probes can pass until the complete runtime is verified. An interrupted or ambiguous guarded upload leaves setup resumable with traffic blocked.

Void preserves manually attached routes and custom domains in both the new configuration and rollback state. R2 recovery checks the bucket's recorded creation identity before completing an interrupted ownership marker write. It won't overwrite a replacement bucket or another installation's marker.

:::

For local API and dashboard development, fork CI, and the source layout, see
[Platform Development](./platform-development.md).

## Install from CI {#install-from-ci}

For your first installation, follow the interactive walkthrough above. Use this section when automating a configured installation.

::: details Non-interactive inputs

Inject the following values from protected CI secrets. Do not commit them in a workflow or a plaintext secrets file.

| Environment variable                         | Value from the interactive setup                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`                       | Management API token                                                                        |
| `VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN` | Runtime API token                                                                           |
| `VOID_PLATFORM_DATABASE_URL`                 | Dedicated PostgreSQL URL                                                                    |
| `VOID_PLATFORM_GITHUB_CLIENT_ID`             | OAuth App client ID                                                                         |
| `VOID_PLATFORM_GITHUB_CLIENT_SECRET`         | OAuth App client secret                                                                     |
| `VOID_PLATFORM_ADMIN_GITHUB_LOGIN`           | Initial administrator's GitHub username                                                     |
| `VOID_PLATFORM_R2_ACCESS_KEY_ID`             | R2 access key ID                                                                            |
| `VOID_PLATFORM_R2_SECRET_ACCESS_KEY`         | R2 secret access key                                                                        |
| `VOID_PLATFORM_JWT_SECRET`                   | Original JWT signing secret                                                                 |
| `VOID_PLATFORM_PROJECT_SECRET_KEY`           | Original base64-encoded project-encryption key                                              |
| `VOID_PLATFORM_RECOVERY_KEY`                 | Base64-encoded 32-byte key for local encrypted recovery state when no keychain is available |

Use that installation's saved signing and encryption keys on every resume or repair that needs them. After a keyring rotation, use the [complete keyring recovery inputs](#manage-an-installation-from-another-machine). The database claim and tables remain after uninstall; use a fresh database for a different installation.

```sh
void platform install \
  --name team \
  --display-name "Team Void" \
  --account <account-id> \
  --application-domain example.app \
  --zone example.app \
  --yes
```

Mutations require `--yes` in CI; a read-only `--plan` does not. Custom runtimes also require `--runtime <directory>`. For a new installation, GitHub's callback must match the final generated API URL; use an explicit `--control-plane-domain` if you need to configure that URL before an unattended first install. Plan output uses placeholder resource names.

:::

## Continuously deploy a source build

Build `@void/platform` from your checkout and pass its runtime directory to `install`, `upgrade`, `repair`, `enable`, or `rollback` with `--runtime`. Custom runtimes get the same integrity, migration, health, and rollback checks as packaged releases.

Void records the runtime's manifest digest, whether it was packaged or custom, and its source revision. A build from a Git checkout automatically records `HEAD`, or `<HEAD>-dirty` when the checkout has uncommitted files. Build systems can set `VOID_PLATFORM_SOURCE_REVISION` to override automatic detection.

A fresh CI runner can discover the installation each time. Set `CLOUDFLARE_API_TOKEN` and `VOID_PLATFORM_DATABASE_URL` through its protected environment, then:

::: details CI commands and recovery inputs

```sh
vp run build

export VOID_PLATFORM_REGISTRY_DIR="$RUNNER_TEMP/void-platform-registry"
export VOID_PLATFORM_RECOVERY_KEY="$(openssl rand -base64 32)"
void platform discover --account "$CLOUDFLARE_ACCOUNT_ID" \
  --installation "$VOID_PLATFORM_INSTALLATION"
void platform upgrade "$VOID_PLATFORM_INSTALLATION" \
  --runtime packages/platform/dist/runtime --plan
void platform upgrade "$VOID_PLATFORM_INSTALLATION" \
  --runtime packages/platform/dist/runtime --yes
```

Omit the installation selector only if the account has one discoverable installation. Run one deployment per installation at a time, and let it finish before starting the next. Cancelling during migrations or Worker rollout can leave an installation waiting for recovery.

Keep the management token, database URL, JWT signing secret, and complete project-encryption keyring in a protected CI environment. Upgrades inherit deployed Worker secrets. The original values are needed when recreating a missing Worker; configuration credentials are also needed when explicitly rotating them.

:::

## Disable and safely uninstall

To pause a platform without removing its data:

```sh
void platform disable [id] --plan
void platform disable [id]
```

Disabled platforms reject requests through a flag in their routing storage. Their domains and routes remain attached. Repair and upgrade preserve the disabled state; restore traffic with:

```sh
void platform enable [id] --plan
void platform enable [id]
```

Add `--yes` to commands that make changes in a non-interactive shell.

While disabled, the platform retries queue batches after five minutes instead of delivering them to apps. Queue retention and retry limits still apply. For a long pause, plan a dead-letter queue or another way to recover messages.

### Uninstall

Preview removal before applying it:

```sh
void platform uninstall [id] --plan
void platform uninstall [id]
```

Uninstall blocks platform traffic, removes transient Queues, and records the resources left for you to review. By default, Workers, KV, R2, Hyperdrive, the dispatch namespace, and AI Gateway remain in your account. Adopted resources, external PostgreSQL, zones, DNS records, routes, and custom domains are always retained.

To also remove eligible data resources owned by the installer:

```sh
void platform uninstall [id] --purge-data
```

Even with `--purge-data`, Void retains Workers, R2, AI Gateway, DNS records, routes, custom domains, adopted resources, external PostgreSQL, and zones. Review those in the Cloudflare dashboard if you want to remove them. The older `--delete-zone` flag is no longer supported.

::: details Why some resources require manual cleanup

Cloudflare can't make deletion of these resources conditional on the exact resource generation Void inspected. A resource could be replaced or repurposed between that inspection and deletion. Void leaves it in place and blocks platform traffic instead.

Before removal, Void verifies remote ownership and compares the installation record with a fresh resource inventory. Changed or missing ownership proof stops the operation. A retry skips work already completed, and the routing namespace is removed last when eligible.

A default uninstall keeps the final `uninstalled` record and disabled flag in the retained routing namespace. PostgreSQL's installation claim and tables also remain; uninstall never deletes the external database.

:::
