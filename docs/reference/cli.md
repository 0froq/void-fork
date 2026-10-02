---
outline: deep
---

# CLI

`void` is a local binary from the installed `void` package.

Use this page as a command reference. If you are setting up a project for the first time, start with [Quickstart](../guide/quickstart.md) and come back here when you need exact command behavior or flags.

## Cheat Sheet

| Command                           | Purpose                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `void deploy`                     | Build and deploy to the configured platform                                   |
| `void prepare`                    | Generate `.void` artifacts without starting Vite                              |
| `void info [--json]`              | Inspect persistent resource names before moving their code                    |
| `void gen model <name> [cols...]` | Scaffold migration + CRUD routes                                              |
| `void gen route <path>`           | Create an API route                                                           |
| `void db push`                    | Apply schema directly without migration files                                 |
| `void db generate`                | Generate SQL migrations from schema changes                                   |
| `void db status`                  | Show local/remote migration status                                            |
| `void db reset`                   | Drop and re-apply all migrations                                              |
| `void db seed`                    | Reset + seed local database                                                   |
| `void db execute <sql>`           | Run SQL against the database (--remote for deployed)                          |
| `void db studio`                  | Open Drizzle Studio (--remote for a deployed external database)               |
| `void secret put <name=value>`    | Set a production secret                                                       |
| `void secret list`                | List production secrets                                                       |
| `void secret sync .env`           | Bulk upload secrets from dotenv file                                          |
| `void env check [--remote]`       | Validate env.ts schema                                                        |
| `void env types`                  | Regenerate .void/env.d.ts from env.ts                                         |
| `void auth login`                 | Authenticate with the project’s saved destination, or choose one              |
| `void account login`              | Authenticate with a Void platform                                             |
| `void cloudflare login`           | Authenticate with Cloudflare through Void                                     |
| `void platform install`           | Install a company Void platform in Cloudflare                                 |
| `void connect <url>`              | Connect the CLI to a Void platform                                            |
| `void project link`               | Link directory to a project                                                   |
| `void project logs`               | Show runtime logs from deployed project                                       |
| `void project requests`           | Show request-level traffic (status, method, timing)                           |
| `void project rollback`           | Roll back to a previous deployment                                            |
| `void project cancel`             | Cancel an active deployment                                                   |
| `void project zero-trust`         | Inspect or override project Zero Trust protection                             |
| `void project purge-cache`        | Purge all cached pages                                                        |
| `void build logs`                 | Stream, tail, or download build logs                                          |
| `void email status`               | Show email readiness on your own Cloudflare account (`--platform cloudflare`) |
| `void email setup`                | Set email up on your own Cloudflare account, without deploying                |
| `void email usage`                | Show monthly recipient attempts, inbound receipts, and quota                  |
| `void email logs`                 | Show recent email delivery activity                                           |
| `void email destinations`         | List verified recipient addresses                                             |
| `void email allow <address>`      | Add a recipient and send a verification email                                 |
| `void email disallow <address>`   | Remove a recipient from the allowlist                                         |
| `void email domain`               | Send and receive at your own domain on a Cloudflare zone                      |
| `void init`                       | Setup wizard for new or existing projects                                     |
| `void migrate`                    | Convert legacy `void.json` and root Wrangler JSON/JSONC into `void.config.ts` |

## Binary Invocation

The docs use `void` for brevity. Outside package scripts, run it with your package manager: `npx void`, `pnpm void`, `yarn void`, or `bunx void`.

Alternatively, you can add `./node_modules/.bin` to your `PATH` so that you can invoke `void` directly when you are in the root directory of your app.

:::warning ⚠️ Prefer local install
Install `void` in your project so the CLI and runtime use the same version.
:::

## Help

```
void --help
void help
void help <command>
void help <group> <command>
void <command> --help
void <group> <command> --help
void <group> help <command>
```

Use `void --help` for the command list, or `void deploy --help` for a specific command. Help is available without signing in or setting up a project.

## Setup

### `void info`

```sh
void info
void info --json
```

Shows each Durable State and WebSocket definition's source file, inferred or explicit name, Worker class, and binding. WebSocket entries also include their route in JSON output. It runs locally without authentication, network requests, or file generation.

Before moving a deployed definition, copy the suggested `name` into `defineDurableState()`, `defineRoom()`, or `defineWebSocket()`. Keep that name after moving the file to preserve the resource. See [Durable State](../guide/durable-state.md#rename-a-file-while-keeping-its-state) and [WebSockets](../guide/websockets.md#move-a-route-while-keeping-its-state) for migration flows, including WebSocket parameter renames.

Resources recorded in `void.lock.json` without a matching definition appear separately. Adopt a suggested name only after identifying the resource you moved. If Void cannot suggest a name, restore its original source and inspect it before moving it again.

`--json` returns `resources` and `recordedResources`. Current entries contain `file`, `definition`, `name`, `nameSource` (`inferred` or `explicit`), `className`, `bindingName`, and an optional `route`. Recorded entries contain `className` and `bindingName`, with `name` and `definition` when a matching name is available.

### `void migrate`

`void migrate` converts legacy `void.json` and root `wrangler.jsonc` or `wrangler.json` files into `void.config.ts`. It also accepts one root `wrangler*.json(c)` file referenced by a supported framework adapter. Void saves backups in `.void/config-migration/`, records resource IDs in `void.lock.json`, and updates supported adapters to use its generated Cloudflare config.

`.void-wrangler.jsonc` is generated for Cloudflare tooling and belongs in `.gitignore`; migration adds the entry. Review and commit `void.config.ts`, `void.lock.json`, and `.gitignore`. `void init` and `void deploy` migrate legacy files automatically. If the project has conflicting or multiple Cloudflare configs, resolve them first. The project's installed `void` package must match the CLI version before Cloudflare deployment.

### `void init`

```sh
void init [--tsconfig] [--github] [--agents] [--git | --no-git]
```

Set up a new or existing Void project. In an empty directory, choose Vite+ or Vite, a framework, and a D1, PostgreSQL, MySQL, or Static Pages starter.

In an existing app, Void adds missing dependencies and scripts and updates the Vite config. If it cannot edit your config, it prints the snippet to add.

The wizard also sets up TypeScript, agent instructions, environment declarations, and a deployment target. Choose Cloudflare, a Void platform, or skip deployment setup. If you skip sign-in, run `void connect` when you're ready. See [Quick Start](../guide/quickstart.md).

Outside an existing repository or workspace package, Void offers to initialize Git. Use `--git` to initialize without a prompt or `--no-git` to skip it. CI requires `--git` to initialize. Workspace packages do not accept these flags.

Run selected setup steps with:

| Flag         | Purpose                                                        |
| ------------ | -------------------------------------------------------------- |
| `--tsconfig` | Update TypeScript configuration, preserving existing settings. |
| `--agents`   | Set up agent instructions and skills for detected agents.      |
| `--github`   | Create the GitHub Actions deployment workflow.                 |

These flags can be combined and skip the other wizard steps. Add `--git` if you also want Git initialization.

For Cloudflare workflows, add a `CLOUDFLARE_API_TOKEN` repository secret. PostgreSQL and MySQL apps also need `DATABASE_URL`.

Void platforms with GitHub Actions support use short-lived OIDC credentials. Authorize the repository with `void github connect <project> --repo <owner/repo> --executor github_actions`. Core self-hosted platforms do not support that integration. See [Deployment](../guide/deployment.md#github).

### `void prepare`

```
void prepare
```

Generates Void’s types and TypeScript configuration without starting the dev server or building the app. Run it after a fresh clone or before typechecking in CI.

## Connect

```sh
void connect
void connect https://platform.example.com
void connect --platform cloudflare
void connect --platform void
```

Connect a project to its deployment destination. With no arguments, choose Cloudflare or a Void platform interactively. A URL selects a Void platform directly. `--platform void` offers saved platforms and an option to enter another URL.

For Cloudflare, Void signs in through the browser when needed, selects an accessible account, and saves `cloudflare.account_id` in `void.config.ts` or resolved state in `void.lock.json`. It shares this setup with `void init`. An existing account selection is preserved; conflicting or inaccessible account settings must be resolved before continuing.

For a Void platform, Void checks the connection and signs you in through your browser when needed. It saves credentials in your system keychain separately for each platform.

The deployment preference is saved in `.void/project.json`. Connecting to another Void platform preserves an existing project link; the CLI explains when that link or an environment override still selects a different destination. Use `void project link` to explicitly choose a project. Cloudflare selection also retains existing Void project metadata so you can switch back later.

In a non-interactive shell, supply a URL or explicit target. Cloudflare requires usable credentials and an unambiguous account (`CLOUDFLARE_ACCOUNT_ID` when needed). For a Void platform, provide `VOID_TOKEN` with a matching `VOID_API_URL`, or reuse a valid origin-scoped keychain session. Use `void connect <url> --no-login` to save the verified connection without authenticating; this option is only available for Void platforms.

## Authentication

`void auth login`, `void auth status`, and `void auth logout` use the destination
saved for the current project by `void init` or `void connect`. If no destination
is saved, interactive commands let you choose Cloudflare or a connected Void
platform. In a non-interactive shell, pass `--platform cloudflare|void` or use
the explicit `void cloudflare` and `void account` commands. Choosing a destination
for authentication does not change the project's deploy target.

`void auth whoami`, `void auth link`, and `void auth token` remain supported for
existing scripts. `whoami` follows the selected destination; `link` and `token`
are Void account operations. Prefer `void auth status`, `void account link`, and
`void account token` in new scripts.

## Void platform account

### `void account login`

Browser login through one of the platform's currently enabled methods. The token is saved in the operating-system keychain, scoped to the platform origin. Login fails closed when no keychain is available instead of writing the token to a plaintext file; headless environments use `VOID_TOKEN` from their secret manager.

If an older CLI login is no longer recognized after updating Void, run `void account login` again. Your saved platform and project links remain unchanged.

Set `VOID_API_URL` alongside `VOID_TOKEN` to identify the platform that issued it.
A token without an API URL is only used for Void Cloud's production API; a saved
connection or project cannot forward it to another platform. To use a platform's
saved login instead, unset `VOID_TOKEN`.

This is optional if you already completed auth during `void connect` or the interactive `void init` flow.

### `void account link [connection-id]`

Link another enabled login method to your current account. Sign in again if your
session is no longer recent, complete the additional provider's browser login,
and confirm the displayed identity. With no connection ID, choose an enabled
method interactively. The optional dashboard exposes the same flow in **Account**.

### `void account logout`

Removes saved credentials.

### `void account whoami`

Prints your current login.

### `void account token`

Copies your human auth token to the system clipboard. It is intended for
interactive troubleshooting and remains subject to login-method revocation. Do
not combine it with a Cloudflare Access service token for CI; machine Access
proof cannot turn a human Void token into an automation identity. Create a
project-scoped credential with `void project token create` instead.

## Cloudflare authentication

Use Void's Cloudflare commands to sign in and manage credentials. No separate Cloudflare CLI is needed. Browser credentials are encrypted and protected by your system keychain.

- `void cloudflare login` — sign in through your browser or switch Cloudflare users.
- `void cloudflare status` — show your identity, credential source, accessible accounts, and deployment account.
- `void cloudflare logout` — remove the local browser session.

Interactive `void connect --platform cloudflare`, `void init`, and `void deploy --platform cloudflare` invoke the same login flow automatically when necessary. Non-interactive CI must set `CLOUDFLARE_API_TOKEN`.

Signing in changes the browser session, not `account_id` in the project configuration. Check `void cloudflare status` after switching users; if the new user cannot access the pinned account, resolve the project target separately before deploying.

An API token or global API key pair in the environment takes precedence over browser credentials. Explicit browser login stops with the names of these overrides; remove them from that shell before signing in. `status` reports the active credential source, and `logout` warns if environment credentials remain active. Explicit browser login requires an interactive terminal; automatic deployment checks continue to reuse valid sessions.

## Project commands

### `void project status [name]`

Show deployments for the configured target.

- Void targets show recent hosted deployments; `[name]` looks up a project by slug and otherwise the linked project is used.
- Cloudflare targets list Worker Versions, identify the active version, and show the recorded migration count. A project name is not accepted because the Worker name comes from `cloudflare.name` in `void.config.ts`.

### `void project link [name]`

Link current directory to an existing hosted Void project by slug, or select interactively if omitted. State is stored in `.void/project.json`. Direct Cloudflare apps use `cloudflare.name` in `void.config.ts` and do not need linking.

### `void project list`

List all accessible hosted projects (slug, role, type, URL). Shared projects are included and the role column distinguishes them from projects you own. For a saved Cloudflare target, this displays the current Worker's versions instead because there is no Void project registry.

### `void project team`

Manage access to a project hosted on a Void platform:

```sh
void project team list [--project <slug>]
void project team invite <email> --role <reader|collaborator|admin> [--project <slug>]
void project team invitations [--project <slug>]
void project team role <user-id> <reader|collaborator|admin> [--project <slug>]
void project team remove <user-id> [--project <slug>]
void project team revoke <invitation-id> [--project <slug>]
void project team leave [--project <slug>]
void project team pending
void project team accept <invitation-id>
void project team decline <invitation-id>
```

Project-scoped commands use `--project`, then `VOID_PROJECT`, then the linked project. Invitations can target only an email address already registered to a user on that platform; they do not create accounts or grant signup access. Only the invited account can accept or decline its invitation.

Readers can view the project but cannot deploy. Collaborators can deploy and manage deploy prerequisites. Project administrators can additionally manage domains, email destinations, GitHub configuration, and the project team. The owner alone can delete the project. See [Project Collaboration](../guide/project-collaboration.md) for the full role boundaries.

Project-scoped team management commands are not available for projects deployed
directly to Cloudflare. The account-scoped `pending`, `accept`, and `decline`
commands use the active connection selected by `void connect <url>`, regardless
of the current project's link or deploy target. `VOID_API_URL` takes precedence;
an unscoped `VOID_TOKEN` selects Void Cloud. These commands display their
platform, and accepting an invitation leaves directory links intact. To link
the invited application, run `void project link` in an unlinked checkout of
that application.

### `void project zero-trust`

Inspect or override protection for a project on a Void platform:

```sh
void project zero-trust status [--project <slug>]
void project zero-trust protect [--project <slug>]
void project zero-trust public [--project <slug>]
void project zero-trust reconcile [--project <slug>]
```

Project selection follows `--project`, then `VOID_PROJECT`, then the linked
project.

Readers can inspect the state. The owner or a project administrator can protect
the project, make it public, or repair drift. `public` does not change the
platform default for future projects. Deploys and rollbacks wait until a
protection change is finished; if one is refused, the owner or a project
administrator can run `void project zero-trust reconcile` before you retry.
These commands do not apply to direct Cloudflare deployments.

### `void project token <create|list|renew|revoke>`

Manage revocable `aud: deploy` credentials for one Void platform project. The
credential can only call the endpoints used by `void deploy`; it cannot access
operator, account, secret-writing, project-deletion, or other projects' routes.

```sh
void project token create --name github-actions --expires-in 30
void project token list
void project token renew <credential-id> --expires-in 30
void project token revoke <credential-id>
```

Pass `--project <name>` outside a linked project. Expiry is bounded to 1–90
days. Create and renew display the bearer value once; replace the stored secret
immediately after renewal because the previous credential is revoked in the
same operation. Project deletion and owner suspension also stop its use. Login
method disablement does not revoke these independent deploy credentials.

Store the printed `VOID_TOKEN` and `VOID_API_URL` in the CI secret manager. The
Access pair passes the perimeter; the scoped Void credential authorizes only
this project's deploy workflow. When prerendering or remote proxy bindings are
used on an Access-protected platform, store `VOID_ACCESS_CREDENTIALS` as an
origin-keyed JSON secret containing both exact HTTPS origins, even if both use
the same service-token pair:

```json
{
  "https://void-company-api.example.workers.dev": {
    "CF_ACCESS_CLIENT_ID": "<service-token client ID>",
    "CF_ACCESS_CLIENT_SECRET": "<service-token client secret>"
  },
  "https://void-company-proxy.example.workers.dev": {
    "CF_ACCESS_CLIENT_ID": "<service-token client ID>",
    "CF_ACCESS_CLIENT_SECRET": "<service-token client secret>"
  }
}
```

`VOID_ACCESS_ORIGIN` scopes a pair to one origin, so selecting only the API
origin is insufficient for a workflow that calls the proxy. Use distinct pairs
in the two entries when the Access policies require them.

### `void project logs`

```
void project logs [--level <level>] [--filter <text>] [--range <duration>] [--deployment <id>]
```

Show runtime logs from the deployed target. Hosted Void targets query retained log history. Cloudflare targets open a live tail for the Worker named in `void.config.ts`; they do not provide historical log storage.

| Flag                 | Purpose                                                                                                                                                                                                         | Default |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `--range <duration>` | How far back to look. Format: `<number><unit>` (m/h/d). Max 7d.                                                                                                                                                 | `1h`    |
| `--level <level>`    | Filter by log level. One of `error`, `warn`, `info`, `log`, `debug`, `all`. `error` also includes uncaught exceptions, non-`ok` outcomes, and any 5xx response — even when the worker neither threw nor logged. | `all`   |
| `--filter <text>`    | Case-insensitive **substring** match against log message text and exception name/message — not a level filter. Shows the full request entry on any hit.                                                         | none    |
| `--deployment <id>`  | Filter logs to a specific deployment ID.                                                                                                                                                                        | none    |

Output shows one line per request (`HH:MM:SS METHOD URL STATUS`) with indented console log and exception lines beneath. Errors and exceptions are colored red, warnings yellow.

Examples:

```
void project logs --level error --range 12h
void project logs --level error --filter websocket
```

Logs include top-level `console.*` calls and uncaught errors captured by Cloudflare Tail. If you catch an error and save it only to your database, it won't appear here. Also log it with `console.error()` or `logger.error()` from `void/log`.

For errors that never reach your Worker, such as edge routing errors or static site requests, use `void project requests --status 5xx`.

On a direct Cloudflare target, `--filter` becomes Cloudflare's live search, `--deployment` selects a Worker Version, and `--level error` selects error invocations. Other individual console levels cannot be filtered, and `--range` does not select history. `void project requests` is hosted-only.

### `void project requests`

```
void project requests [--status <filter>] [--range <duration>]
```

Show request traffic for the linked project, including static assets and edge errors that do not appear in Worker logs.

| Flag                 | Purpose                                                                                       | Default |
| -------------------- | --------------------------------------------------------------------------------------------- | ------- |
| `--status <filter>`  | Filter by status: a class (`2xx`, `3xx`, `4xx`, `5xx`) or an exact 3-digit code (e.g. `500`). | none    |
| `--range <duration>` | How far back to look. Format: `<number><unit>` (m/h/d). Max 7d.                               | `1h`    |

Output shows one line per request (`HH:MM:SS METHOD STATUS TYPE DURATION`). 5xx are colored red, 4xx yellow. Note: request paths are not recorded, so this view shows status and type rather than URLs — use `void project logs` for per-URL, per-log detail on requests that do reach your worker.

Examples:

```
void project requests --status 5xx
void project requests --range 24h
```

### `void project rollback [deployId]`

```
void project rollback [deployId]
```

Roll back to a previous deployment or Worker Version.

- If `[deployId]` is omitted, shows an interactive select menu of retained deployments
- If the target deployment has fewer applied migrations than the current one, a warning is shown listing the migration diff before confirmation

On a Void platform, you can select a retained deployment. On Cloudflare, use a complete Worker Version ID or an unambiguous prefix. Void activates that version at 100%. When both versions have complete trigger snapshots, it also restores the selected version's schedules, queues, workflows, routes, and custom domains. Otherwise, rollback keeps the current triggers and restores the code, including versions originally deployed outside Void.

Rollback doesn't reverse database migrations. If older code may run against a newer schema, or migration metadata is missing, Void explains the risk and asks for confirmation.

### `void project cancel [deployId]`

```
void project cancel [deployId]
```

Cancel an active deployment.

- If `[deployId]` is omitted, shows an interactive select menu of active deployments for the linked project
- If `[deployId]` is provided, cancels that deployment directly

This command is hosted-only. Direct Cloudflare deploys are local operations and do not expose a remote build to cancel.

### `void project delete [name]`

Permanently delete a hosted Void project and all its resources (databases, KV namespaces, R2 buckets, deployments). Requires typing the project slug to confirm.

If `[name]` is omitted, uses the linked project.

For direct Cloudflare targets this command refuses to run. Inferred resources can be shared, so Void never performs automatic teardown; verify ownership and remove resources explicitly with Cloudflare tooling.

### `void project purge-cache`

```
void project purge-cache [--project <name>]
```

Purge all cached pages for the linked project. The edge cache will clear within seconds.

If `--project` is provided, purges that project's cache instead of the linked project.

This command is currently hosted-only. Direct Cloudflare cache purge fails closed with guidance.

## Platform management

Void-managed projects deploy to an explicitly selected platform. Join one with [`void connect`](#connect). Connections are stored per API origin, and credentials are scoped to that origin.

### Connection commands

```sh
void platform list
void platform use [id]
void platform status [id]
```

`use` and `status` auto-select the only configured platform; with multiple platforms they show a picker interactively and require an id or URL in non-interactive use. A project with a recorded platform URL keeps using that platform when the global default changes.

### Operator commands

Use `void platform` to administer the users and apps on your selected platform. Start with the [Platform Administration guide](../guide/platform-administration.md) for signing in, giving people access, and investigating deployments.

Every command below accepts `--connection <registered-id-or-url>` to select a platform and `--json` for structured output. Without `--connection`, Void uses `VOID_API_URL` if set, then the active platform connection. Application project files do not change this selection.

#### Making Changes

Commands that change users, projects, signup access, invitations, or Workers show a preview before asking for confirmation:

```sh
void platform user plan <user-id> pro --plan
void platform user plan <user-id> pro --yes
```

`--plan` validates the change and prints its effect without applying it. `--yes` applies the change without prompting, which is required in scripts. Use one or the other; they cannot be combined. These flags also apply to deployment cancellation and maintenance commands, but not to authentication commands.

Each preview and apply request allows five minutes. Set `--timeout <seconds>` to an integer from 1 to 3600 to change that limit. Read requests and individual log polls allow 30 seconds.

Void does not automatically retry changes. If a request loses its connection or times out, inspect the affected objects and `void platform system events` before repeating it. Partial results describe the work that completed and exit with a nonzero status.

#### Authentication {#operator-authentication}

Sign in, inspect your session, or sign out:

```sh
void platform auth login [--provider <connection-id>] [--token-stdin]
void platform auth status
void platform auth logout
void platform auth token [--token-stdin]
```

With no `--provider`, browser login offers the platform's enabled login methods.

#### Plan configuration

`void platform config plans` opens an interactive plan menu using your administrator session. Plans have stable IDs and editable display names. Copy an existing plan to add one, edit limits without redeploying, archive it to stop new assignments, or remove it with an explicit replacement for its accounts.

```sh
void platform config plans show [plan-id]
void platform config plans add <plan-id> --copy <existing-id> --name "Team"
void platform config plans set <plan-id> [--name "Team"] [--file plan.json]
void platform config plans reset <builtin-plan-id>
void platform config plans archive <plan-id>
void platform config plans restore <plan-id>
void platform config plans remove <plan-id> [--replacement <plan-id>]
void platform config plans default <plan-id>
void platform config plans sync
```

Use `--plan` to preview changes and affected accounts; scripted mutations require `--yes`. Every command supports `--connection <registered-id-or-url>` and `--json`. `show` reports the effective limits, default, assignments, and pending account updates. `reset` restores a built-in plan's original limits and build instance size. Archived plans keep their existing accounts but cannot receive new assignments; change the default before archiving it. `remove` requires a replacement for a plan that has accounts or is the default. Changing the default affects only new accounts.

For `add` and `set`, `--file` reads a JSON object with optional `name`, `limits`, `buildInstanceType`, and boolean `allowShortSlugs`. `limits` is a partial object of nonnegative whole numbers; `0` means unlimited by the plan. Build timeouts remain capped at the platform maximum of 60 minutes; `0` uses that maximum. Omitted settings keep their current values or the copied plan's values. `buildInstanceType` is `standard-3` or `standard-4`. `allowShortSlugs` permits future assignments of project slugs of five characters or fewer; existing URLs remain available. Storage quotas are not editable. See [Plans and Limits](../guide/platform/administration/plans.md) for supported limits and examples.

An apply checks the preview's revision and rejects concurrent changes. Lower quotas can restrict accounts already above them; usage history and billing periods are preserved. The CLI continues account updates until complete. If an update fails or stops making progress, the configuration remains saved and the command exits unsuccessfully. Run `sync --yes` to continue before editing plans again. Inspect `show` and operator events after an uncertain request outcome.

#### Authentication configuration

`void platform config auth` opens interactive configuration. These commands use
your administrator session from `void platform auth login`:

```sh
void platform config auth list
void platform config auth show company
void platform config auth add google
void platform config auth add oidc --id company
void platform config auth add cloudflare-access --id access
void platform config auth configure company
void platform config auth test company
void platform config auth link company
void platform config auth enable company
void platform config auth disable github
void platform config auth admission
void platform config auth protection show
void platform config auth protection enable --installation <id>
void platform config auth protection disable --installation <id>
void platform config auth recover company --installation <id> --file recovery.json
```

When configuring an existing installation for the first time, run
`void platform config auth initialize`, then sign in again. Its current login
methods and signup policy are preserved.

Adding or editing a method saves a pending configuration. Enabling it verifies the
login in your browser before applying it. Linking the verified identity to your
account is a separate, explicit action. Before disabling a method, verify a linked
alternative; the last method cannot be disabled. Disabling revokes human sessions
created through that method, including operator sessions. Scoped deployment tokens
remain valid; a human login token used as `VOID_TOKEN` is still revoked.

Commands accept `--connection <registered-id-or-url>` and `--json`. Changes accept
`--plan` or `--yes`. For scripted configuration, use `--file <path>` for the
nonsecret fields and `--client-secret-env <name>` for the environment variable
containing the secret. Omit the secret when editing to retain its saved value.
For `enable` or `link` in scripts, supply `--test-id <id>` from a completed test.
`test --json` returns a browser URL, test ID, and expiry without waiting for completion.

`admission` chooses invited/allowlisted, company-approved, or public signup.
Company-approved signup creates ordinary accounts automatically when a user
passes a configured company rule. Select an enabled, company-restricted OIDC or
Google Workspace method, or an enabled Cloudflare Access gate. In scripts,
`admission --file <path> --yes` reads a policy such as
`{"mode":"company","connections":["company"],"access":false}`.

Browser login offers the platform's enabled methods; `--provider <connection-id>` selects one. Login saves a one-hour administrator session in your system keychain. Logout revokes that session and removes its local credential.

`protection enable` creates or connects Cloudflare Access applications independently
of login methods. Its `--file` accepts the `cloudflareAccess` object described in
[installation setup](../guide/platform/installation/setup.md#choose-login-methods).
Protection changes require installation ownership, the saved recovery credentials,
and a human administrator session. They revoke current human sessions. Before
removing protection, change any signup rule that depends on that gate. Cloudflare
applications are retained for deliberate cleanup.

`recover <connection-id>` restores an existing administrator when normal login is
unavailable. Its file contains `administratorUserId`, optional nonsecret provider
`configuration`, and an `expectedIdentity` object with exact `issuer` and `subject`
when using `--yes`. Recovery requires Cloudflare management/database authority,
original recovery keys, and a successful browser provider test. Use
`--client-secret-env <name>` for new or rotated credentials.

`auth token` prints your current operator token. With `--token-stdin`, it exchanges a full administrator API login session from standard input for a new operator token. `auth login --token-stdin` saves the exchanged token to the keychain instead of printing it.

For automation, supply `VOID_OPERATOR_TOKEN` with an explicit `VOID_API_URL` or `--connection`. Operator tokens are stored separately from application deployment credentials. The API checks your current administrator access on every request. See [Using Scripts](../guide/platform/administration/operations.md#using-scripts) for an example.

#### Users {#operator-users}

Find a user by login, email, or ID, then inspect their projects and usage:

```sh
void platform user list [--search <text>] [--page <n>] [--limit <n>]
void platform user show <id>
```

Use the same ID to change a plan, suspend or restore the account, or delete it:

```sh
void platform user plan <id> <free|solo|pro|sponsored|custom>
void platform user suspend <id> [--reason <text>]
void platform user restore <id>
void platform user delete <id>
```

Suspending a user blocks their applications. Deleting a user also deletes their project resources. A plan change updates resource limits while preserving any administrator suspension.

The last active administrator cannot be deleted or suspended. Both previews and
actual mutations enforce this rule, including in the browser admin UI. Allowed
administrator removals revoke administrator access before resource cleanup; if
cleanup fails, access stays revoked and the partial result reports it.

#### Projects {#operator-projects}

List projects across the platform, filter them by owner, or inspect one project's resources:

```sh
void platform project list [--user <user-id>] [--search <text>] [--page <n>] [--limit <n>]
void platform project show <id>
void platform project normalize <id> [--plan | --yes]
void platform project delete <id>
void platform project owner <project-id> <user-id>
```

Search matches a project's slug, ID, or owner's login. `show` includes resources, domains, the latest 10 deployments, and the latest 20 builds. `delete` removes the project and its resources.

If deployment reports that a project requires normalization, an operator can preview `normalize <id> --plan`, then apply it with `--yes`. It verifies the serving deployment and any recorded queue names before updating project records. It leaves traffic and Cloudflare resources in place and refuses changes while deployment or recovery is active. If a verified queue name differs from the expected delivery routing name, normalization refuses the change; reconcile that queue routing before retrying. If the serving deployment cannot be verified, investigate the reported route before retrying. Finish interrupted deployment recovery on the previous compatible platform runtime before upgrading a project whose active deployment is missing.

`owner` transfers a project to another registered user. Preview it with `--plan`; apply it interactively or with `--yes`. The preview reports active-work blockers and the account plan that will apply. The former owner becomes a project administrator, existing project-scoped CI deploy credentials are revoked, and usage already incurred remains with the former owner.

#### Project Zero Trust {#operator-zero-trust}

Configure the installation-wide Cloudflare Access policy and project overrides:

```sh
void platform zero-trust status [--check]
printf '%s' "$ACCESS_API_TOKEN" | void platform zero-trust configure \
  --identity-providers <id[,id...]> \
  --policies <id[,id...]> \
  [--existing-projects <protected|public>] \
  [--protect-new-projects] \
  --token-stdin \
  --yes
void platform zero-trust reconcile
void platform zero-trust disable

void platform zero-trust project-status <project-id>
void platform zero-trust project-protect <project-id>
void platform zero-trust project-public <project-id>
void platform zero-trust project-reconcile <project-id>
```

Mutations support `--plan`, `--yes`, and `--timeout`; use `--plan` instead of
`--yes` to inspect this change without applying it. The Access management token
is accepted only on standard input. Zero Trust uses the Cloudflare account that
hosts the platform. Omit `--protect-new-projects` to make new projects public
by default. `--existing-projects` is required when you enable Zero Trust and
rejected once it is enabled; later configuration changes keep each project's
protection. `status` reports saved state; `--check` also compares it with
Cloudflare Access. If status remains `configuring` or `disabling`, run
`void platform zero-trust reconcile` to resume the saved operation. Protected
projects support up to 100 custom domains.

The token needs **Access: Apps and Policies Write** plus **Access:
Organizations, Identity Providers, and Groups Read**, scoped to the platform's
Cloudflare account. Select at least one Allow policy that matches people by
identity; Void rejects Bypass and Service Auth policies and rules that allow
Everyone or any service token. See [Project Zero Trust](../guide/platform/administration/zero-trust.md)
for requirements and recovery.

#### Deployments {#operator-deployments}

Find a deployment, inspect its manifest, or request cancellation:

```sh
void platform deployment list [--project <id-or-slug>] [--status <status>] [--search <text>] [--page <n>] [--limit <n>]
void platform deployment show <id>
void platform deployment cancel <id>
void platform deployment migrate-assets <id> [--cursor <cursor>] [--plan|--yes]
```

Cancellation applies while a deployment is pending, uploading, migrating, or prerendering, and can be requested again while it is canceling. A deployment that has begun switching traffic, is compensating for a failure, or has finished cannot be canceled through this command.

`migrate-assets` copies legacy assets to scoped R2 storage, verifies their contents, and updates each batch only after all its assets are verified. Original assets remain in place, and application traffic stays on the same deployment. Upgrade the platform runtime before using this command. Migrate both active deployments and retained rollback deployments before removing support for older asset storage.

Use `--plan` to preview the first batch. Applying authorizes all remaining batches for that deployment; the CLI previews each batch and prints its result, including `nextCursor`. With `--json`, results are JSON Lines. If a later batch fails or the command is interrupted, resume with the cursor from the last successful result. An ambiguous request is never retried automatically; inspect the deployment before resuming. A completed migration reports `complete: true` and `nextCursor: null`.

Use [`void platform system asset-migrations`](#operator-system) to find deployments requiring migration. Inspect every inventory page, migrate each deployment with `needsMigration` greater than zero, then inspect every page again. Include retained rollback deployments and stored bundles. Investigate rows marked `invalid` before considering migration complete. Keep the older asset readers until the full inventory is valid and no protected deployment needs migration.

Read its runtime logs with:

```sh
void platform deployment logs <id> [--since <time>] [--cursor <cursor>] [--limit <n>] [--follow]
```

The default is the last hour, oldest first, with up to 100 records. `--since` accepts a duration such as `10m`, `2h`, or `1d`, an ISO date, or epoch milliseconds. Set `--limit` from 1 to 500 and pass the response's `nextCursor` as `--cursor` to read another page.

`--follow` reads the remaining pages and checks for new logs every two seconds until you press Ctrl+C. It checks a five-minute overlap for delayed records and suppresses replayed rows. Records that arrive later may need a subsequent historical query. Following stops with an error if a window exceeds 10,000 records; use a narrower historical query in that case.

#### Builds {#operator-builds}

Inspect a build or read its output:

```sh
void platform build show <id>
void platform build logs <id> [--since <sequence>] [--limit <n>] [--follow]
```

Build logs start at sequence `0` and return up to 500 lines. Use the returned `lastSeq` as `--since` to continue; `--limit` accepts 1 to 500. Container log retrieval requires managed builds to be enabled. GitHub Actions builds return an external log URL.

Following waits for the final logs after the build becomes terminal. If completion cannot be confirmed within two minutes, the command exits with an error. Older builds without a completion signal may wait for 30 seconds without new lines before following stops.

#### Signup Access {#operator-signup}

Inspect signup restrictions, open signup to everyone, or require an allowlist match:

```sh
void platform signup show
void platform signup open
void platform signup restrict
```

Add and remove GitHub or email entries by their type and pattern:

```sh
void platform signup allow <github|email> <pattern> [--note <text>]
void platform signup disallow <github|email> <pattern>
void platform signup remove <github|email> <pattern>
```

`remove` remains available as an alias for existing scripts. GitHub entries match a login. Email entries match an address or a domain pattern such as `*@example.com`, across sign-in providers. Quote wildcard patterns in your shell.

For an OIDC identity that has no verified email, grant access using its configured connection ID and stable provider subject:

```sh
void platform signup allow identity <connection-id> <subject> [--note <text>]
void platform signup disallow identity <connection-id> <subject>
```

Connection IDs are shown by `void platform config auth list`. Identity subjects match exactly and case-sensitively; wildcards, email inference, and account linking are not applied. The login method's domain or group restrictions must still pass, and a newly admitted account has the ordinary user role. Under invited/allowlisted signup, an empty allowlist blocks new accounts. Under company-approved signup, explicit grants admit people in addition to the company rules.

#### Invitations {#operator-invitations}

Invite people by email and track whether they have joined:

```sh
void platform invitation list [--page <n>] [--limit <n>]
void platform invitation send <email[,email...]>
void platform invitation revoke <id>
```

Send accepts up to 100 comma-separated addresses. Invitations grant signup access even if email delivery is unavailable or fails; delivery is reported separately. Share the platform's `/invite` page or `void connect '<platform URL>'` command yourself when no email is sent. Revoking a pending invitation removes its exact email grant. A broader domain entry can still allow that person to sign up.

#### Email {#operator-email}

Decide who mail from the shared sender may reach, who registers email domains, and a project's outbound caps:

```sh
void platform email policy
void platform email policy-set <verified|domains|any> [--domains <domain[,domain...]>]
void platform email settings
void platform email settings-set --domains <self-serve|admin>
void platform email limit <project-id|slug> [--monthly <n>] [--burst <n>]
void platform email logs <project-id|slug> [--page <n>] [--limit <n>] [--json]
void platform email attempts [--project <id|slug>] [--page <n>] [--limit <n>]
void platform email attempt-resolve <attempt-id> --ended --reason <text>
void platform email operation-resolve <operation-id> --ended --outcome <applied|not-applied> --reason <text>
void platform email shared-recipients [--project <id|slug>] [--page <n>] [--limit <n>]
void platform email shared-recipient-resolve <recipient-id> --ended --outcome <applied|not-applied> --reason <text>
```

`policy` decides which recipients a project's `<slug>+tag@<mail domain>` sender reaches: `verified` (the default) means only that project's verified destinations; `domains` adds every address on the listed domains; `any` lifts the check. Neither widens delivery to addresses on the platform's own mail domain: those stay verified-destination-only, so no project reaches another project's inbox without its consent. Cloudflare still refuses a destination it has not verified until the platform mail domain is onboarded for Email Sending, so under `domains` or `any` such refusals arrive as per-recipient `UNVERIFIED_DESTINATION` results. Custom-domain sends are not affected.

`settings-set --domains admin` tells `void email domain add` to print the administrator's command instead of starting token setup. `limit` overrides the project's monthly and rolling 60-second caps (defaults 200 and 10); a project page in the admin UI shows and clears them.

`logs` inspects retained receipt and recipient outcomes, including operation IDs, provider references, error codes, and policy versions. Pages contain at most 100 records, newest first; use `--json` for all fields. After project deletion, use its project ID to inspect metadata until the 30-day retention period expires. Message content and credentials are never included.

`attempts` lists interrupted provider calls and their earliest resolution time. Once
the original Worker execution has ended and the attempt is at least 24 hours old,
`attempt-resolve` records `outcome_unknown`, retains its quota charge, and releases
the project/domain cleanup fence. `--ended` is your attestation that the call is no
longer active; `--reason` is stored in the operator audit log. Keep recipient
addresses and message content out of the reason. The send is never retried. Use
`--plan` to preview and `--yes` to apply without a prompt.

`operation-resolve` recovers a Cloudflare routing, Worker, secret, catch-all, or
Sending mutation whose outcome remains unknown. After the original execution
has ended and the operation is at least 24 hours old, inspect the exact resource
named by the preview and attest whether its write was `applied` or `not-applied`.
Applied writes continue at the next step; not-applied writes retry the same
persisted intent. The running platform version must match that intent, so restore
the matching version before recovering an operation created by older code. The
preview pins the step, attempt, connection and route generations, resource
identity, and digest used by the apply request. Time alone never retries a write.

`shared-recipients` discovers shared inbound addresses, provider rule names and
IDs, and interrupted creation intents, including projects awaiting deletion.
If creation has an unknown outcome, use `shared-recipient-resolve` after the
original execution has ended and its creation intent is at least 24 hours old.
Inspect the exact account, zone, recipient and rule named by `--plan`, and use
Cloudflare's provider audit to establish whether creation was `applied` or
`not-applied`. A missing rule alone is insufficient evidence for `not-applied`.
Supply that finding in `--reason`; it is recorded in platform events.

Applied recovery requires the exact owned rule to be present and records its
ID. Not-applied recovery releases the creation intent only after repeated
provider inspection and your attestation. Both outcomes leave delivery unready
until normal reconciliation verifies it. Recovery itself creates or deletes no
provider rule and never reopens a deleting project; retry deletion afterward
when recovering cleanup. Use `--yes` to apply the preview without a prompt.
If the intent or provider ownership changes, inspect a new plan.

Register and maintain email domains for projects whose owners hold no Cloudflare credential:

```sh
void platform email domains [--project <id|slug>]
void platform email domain-add <domain> --project <id|slug> [--token-stdin]
void platform email domain-status <domain>
void platform email domain-sync <domain>
void platform email domain-rotate-secret <domain>
void platform email domain-remove <domain> [--token-stdin]
```

`domain-add` uses the platform's Cloudflare credential for zones in its account. For another account, pipe a scoped Cloudflare API token on standard input with `--token-stdin --yes`. Managed custom inbound email requires the Cloudflare zone apex (`example.com`). If its MX records already belong to another mail provider, use the project's shared email address or choose another unused zone. Native Cloudflare deployments also support literal recipient addresses on subdomains; see [Your own Cloudflare account](../guide/email.md#your-own-cloudflare-account).

`domain-status` shows inbound, outbound, and credential-management readiness with the latest operation. A blocked operation resumes through `domain-sync`; a blocked rotation resumes through `domain-rotate-secret`, preserving already confirmed steps and its staged credential. An uncertain operation remains stopped until read-back proves the result or an administrator uses `operation-resolve`. Domains an administrator adds show `managed_by: admin`; their owners can list and inspect them but use these commands for `sync`, `domain-rotate-secret`, and `remove`.

If project deletion leaves cleanup blocked by an expired or revoked Cloudflare token, use `domain-remove <domain> --token-stdin --yes` with a replacement scoped to the same account and zone. This resumes the retained cleanup only when no other project uses the connection. For a live project, renew its token through `domain-add` instead.

#### System {#operator-system}

Inspect activity, check service health, or review administrative changes:

```sh
void platform system overview
void platform system health
void platform system cli-versions
void platform system asset-migrations [--page <n>] [--limit <n>]
void platform system events [--page <n>] [--limit <n>]
void platform system backfill-queue-tokens
void platform system sandbox-drain [--cursor <opaque-cursor>]
```

`overview` shows platform totals and recent activity. `health` checks the configured services and database, and exits with a nonzero status if a check fails. `cli-versions` reports the CLI versions used by deployments.

`asset-migrations` inventories active deployments, retained rollback deployments, and deployments with stored bundles. It reports their asset counts, `needsMigration`, and an `invalid` flag for unreadable metadata. Read all pages using the response's pagination fields. Migrate each deployment with `needsMigration` greater than zero through [`deployment migrate-assets`](#operator-deployments), then rerun the full inventory. Migration keeps the original assets; removing those assets or their older readers requires separate verification.

`events` shows the administrator, target, and outcome of changes. A pending event means the outcome has not been recorded. Previews and session login/logout do not create these events. `backfill-queue-tokens` repairs older queue entries that are missing authentication tokens and supports `--plan` before applying the repair.

Use `sandbox-drain` when an upgrade from the legacy tenant-owned Sandbox runtime asks you to finish cleanup. Preview with `--plan`; pass the returned `nextCursor` as `--cursor` to inspect later pages. Apply with `--yes` and rerun until it reports `complete: true`, then rerun the interrupted upgrade. Application traffic stays paused during cleanup, while administrator login remains available. The completed upgrade enables the current managed Sandbox controller automatically.

Use the [platform lifecycle commands](#lifecycle-commands) to maintain your installation's Workers.

#### Hosted Workers {#operator-workers}

The following commands manage the Workers of the hosted Void Cloud platform.
They are unavailable on a self-hosted installation; use the
[lifecycle commands](#lifecycle-commands) there instead.

```sh
void platform worker list [--environment <production|staging>]
void platform worker show <worker-name> [--environment <production|staging>]
void platform worker rollback <worker-name> <version-id> [--environment <production|staging>]
void platform worker rollback-all [--environment <production|staging>]
void platform worker events [batch-id] [--environment <production|staging>]
```

Use a name from `worker list`, such as `api` or `proxy`. `show` lists its
versions and current deployment. Preview either rollback with `--plan`, then
apply it interactively or with `--yes` in a script. `events` lists worker
operation events or inspects one batch by ID.

#### Pagination and JSON

User, project, deployment, invitation, and event lists default to page `1` with 20 items. `--limit` accepts 1 to 100 for these lists. Their JSON responses include the page, limit, and total count.

With `--json`, results go to standard output and command errors go to standard error as JSON. Errors and partial failures exit with a nonzero status. An unhealthy `system health` result stays on standard output and also exits nonzero. Log following writes one JSON object per response, including each page and empty responses.

### `void platform install`

```sh
void platform install [options] [--yes]
```

| Option                            | Purpose                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| `--name <slug>`                   | Installation name used in `void-<name>-<role>` resource names; choose an unused name |
| `--display-name <name>`           | Human-readable platform name                                                         |
| `--account <id>`                  | Cloudflare account id                                                                |
| `--auth-config <path>`            | Login methods, signup policy, and environment references for provider secrets        |
| `--login-methods <methods>`       | Comma-separated `github`, `google`, `oidc`, or `cloudflare-access` login methods     |
| `--access-protection`             | Protect the platform UI and APIs with Cloudflare Access                              |
| `--no-access-protection`          | Skip Cloudflare Access protection                                                    |
| `--hyperdrive <create\|id>`       | Create Hyperdrive or use the specified existing configuration                        |
| `--application-domain <domain>`   | Base domain for deployed apps                                                        |
| `--workers-dev`                   | Explicit testing mode; add an application domain later                               |
| `--zone <domain>`                 | Cloudflare zone containing the application domain                                    |
| `--dedicated-zone`                | Add zone-wide catch-all routes; valid only when the app domain is the whole zone     |
| `--no-dedicated-zone`             | Skip zone-wide application catch-all routes                                          |
| `--control-plane-domain <domain>` | Optional API custom hostname; defaults to `workers.dev`                              |
| `--no-control-plane-domain`       | Use the default `workers.dev` API hostname                                           |
| `--dashboard-url <origin>`        | HTTPS origin of an optional dashboard deployed separately                            |
| `--plan`                          | Resolve and print a read-only plan                                                   |
| `--resume`                        | Continue the matching checkpointed installation                                      |
| `--runtime <path>`                | Deploy a locally built, integrity-checked runtime directory                          |
| `--yes`                           | Acknowledge Cloudflare changes in non-interactive use                                |

For a first installation, follow [Install a Void Platform](../guide/self-hosted-platform.md). The interactive installer recommends using a domain and offers **Use workers.dev for testing** as a visible alternative. Void creates the platform infrastructure and tables. External PostgreSQL and a configured login method are required in either mode; GitHub OAuth is the default login choice, not a requirement. `--workers-dev` skips zone/DNS/certificate operations and cannot be combined with `--application-domain`, `--zone`, or `--dedicated-zone`.

Read-only plans, workers.dev installations with the default API hostname, and supported lifecycle operations can use Cloudflare browser login and the system keychain. Installation that writes DNS or creates a zone needs an explicit management token through `CLOUDFLARE_API_TOKEN` or `CF_API_TOKEN`.

The installed platform needs a separate runtime token to provision resources for apps. The interactive installer prompts for it and the other setup values. For non-interactive installs, inject the variables listed in [Install from CI](../guide/platform/installation/ci.md).

To enable email during install or upgrade, set both `VOID_EMAIL_SENDER_DOMAIN` and `VOID_EMAIL_SHARED_ZONE_ID`. Void records the pair for later upgrades; supplying only one is an error.

Use `--dashboard-url https://dash.example.com` when deploying the optional user
dashboard separately. The URL must be an HTTPS origin without credentials, a
path, query, or fragment. Void permits that origin's login callbacks and saves
it for later maintenance; it does not deploy a dashboard Worker. Omission keeps
an existing installation's saved dashboard origin.

`--plan` previews resource names, login methods, callback URLs, and credential requirements. Run the install or resume command printed at the end to continue. For login configuration, use either `--auth-config` or `--login-methods` with the Access protection flags.

New resources use `void-<name>-<role>` names; choose an unused installation name. The installer opens setup pages for missing credentials and reuses values already supplied.

Installation progress and partial credentials are saved encrypted locally. Rerun the installer to continue unfinished setup, or pass `--resume --name <id>`. Use lifecycle commands for completed installations.

Use an empty PostgreSQL database dedicated to the installation. You can correct a failed initial connection, but after the database is claimed or Hyperdrive is provisioned, commands reject a different URL.

Choose whether Void creates Hyperdrive or uses an existing configuration. An existing Hyperdrive must point to the platform database with SQL result caching disabled. Supply a database owner URL for migrations. See [Use an existing Hyperdrive](../guide/platform/installation/prerequisites.md#use-an-existing-hyperdrive) for setup and [Install from CI](../guide/platform/installation/ci.md) for unattended inputs.

Recovery secrets are encrypted using your system keychain. Without one, supply a base64-encoded 32-byte `VOID_PLATFORM_RECOVERY_KEY`. Keep the original credentials in protected CI secrets for recovery.

If a newly created zone is waiting for registrar delegation, resume after it becomes active:

```sh
void platform install --resume --name <installation-id>
```

See [Self-host a Void platform](../guide/self-hosted-platform.md) for prerequisites, token scope, exact footprint, domain behavior, and an end-to-end walkthrough.

### `void platform domain set`

```sh
void platform domain set <domain> [--installation <id>] [--zone <domain>] [--dedicated-zone] [--plan] [--yes]
```

Add an application domain to a workers.dev test platform. Domain-based installations remain the recommended default. The command detects the zone when possible, creates missing DNS and routes after confirmation, and checks HTTPS and project Zero Trust protection before making the domain canonical. If DNS, certificates, or protection are pending, rerun the same command to resume. `--plan` is read-only; non-interactive mutations require `--yes`.

Existing workers.dev URLs remain available, and the platform API origin, OAuth callback, projects, and deployments stay unchanged. The command verifies the running runtime token's Cache Purge permission for the new zone. A disabled platform stays disabled. Use the database URL from the original installation when administering from another machine. Replacing an already configured application domain is not supported. See [Adding a Domain](../guide/platform/installation/domains.md#adding-a-domain).

### Lifecycle commands

Use these commands to recover, update, pause, or remove an installation:

```sh
void platform discover [--account <id>] [--installation <id-or-name>]
void platform upgrade [id] [--runtime <path>] [--dashboard-url <origin>] [--plan] [--yes]
void platform rollback [id] --runtime <earlier-path> [--from-runtime <current-path>] [--plan] [--yes]
void platform repair [id] [--runtime <path>] [--dashboard-url <origin>] [--plan] [--yes]
void platform disable [id] [--plan] [--yes]
void platform enable [id] [--runtime <path>] [--plan] [--yes]
void platform uninstall [id] [--plan] [--purge-data] [--keep-zone] [--yes]
```

`discover --installation` limits recovery and endpoint verification to one installation in a shared Cloudflare account.

Omit `id` when only one installation is configured, or choose from the interactive picker. Non-interactive commands need an ID when several installations exist. Commands that make changes also require `--yes`; `--plan` only previews changes.

To add or explicitly change a separately deployed dashboard after installation,
use `repair --dashboard-url <origin>` or `upgrade --dashboard-url <origin>`.
Preview with `--plan` first. Existing Access protection must cover the configured
dashboard origin before maintenance can proceed. See [Optional Dashboard](../guide/platform/installation/domains.md#optional-dashboard).

After discovery on another machine, set `VOID_PLATFORM_DATABASE_URL`. An upgrade that preserves every deployed Worker also preserves its secrets. For an email-enabled installation without its encrypted recovery file, restore `VOID_PLATFORM_EMAIL_SIGNING_SECRET`; recreating only the email gateway needs that key and does not need the Cloudflare runtime token or JWT signing key. Recreating the API or proxy also requires the email key when email is enabled, in addition to their normal secrets. Recreating the API requires its original runtime-token, GitHub, R2, JWT, and project-encryption values; recreating the proxy requires the runtime token and JWT signing key.

| Command     | Behavior                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------- |
| `discover`  | Verifies remote ownership and restores local installation records without downloading secrets |
| `repair`    | Recreates missing resources owned by the installer                                            |
| `upgrade`   | Deploys the selected runtime and supported pending migrations                                 |
| `rollback`  | Restores a declared-compatible earlier runtime without reversing PostgreSQL migrations        |
| `disable`   | Blocks platform traffic through routing storage without removing data                         |
| `enable`    | Restores traffic after checking the platform                                                  |
| `uninstall` | Blocks traffic and removes eligible resources, retaining data by default                      |

Repair and upgrade preserve disabled state. New, resumed, and previously disabled installations block user traffic until all target Workers pass verification; the installer's health probes can still run. Routes and custom domains remain attached.

`--runtime` selects a custom platform build. Relative paths resolve from your current directory. Void verifies the build before making changes; see [Platform Development](../guide/platform/development/runtime.md#deploying-your-runtime) for creating one.

Without `--runtime`, the CLI uses its packaged platform version.

Platform migrations only move forward. Void checks compatibility before updating the database and tells you if an intermediate release is needed.

An upgrade completes after the new Workers pass health checks. If rollout fails, Void attempts to restore the previous Workers. Retrying does not repeat completed migrations.

`platform rollback` restores a compatible earlier runtime without reversing database migrations. Pass its files with `--runtime`; if the installed version is custom, also supply that version with `--from-runtime`. Void refuses incompatible targets.

Uninstall verifies remote ownership before removing anything. Data resources are retained unless you pass `--purge-data`. Workers, the Queues they use, R2, AI Gateway, DNS records, routes, custom domains, adopted resources, external PostgreSQL, and zones are always retained for manual review.

See [Disable and Uninstall](../guide/platform/installation/uninstall.md#remove-retained-resources) for the full removal policy and the cleanup order.

## Deploy

### `void deploy`

```
void deploy [--project <name>] [--dir <path>] [--spa] [--skip-build] [--debug]
void deploy [--platform <cloudflare|void>] [--require-email]
void deploy --platform cloudflare --atomic
```

Auto-detects your project type and chooses the right pipeline. See [Supported App Types](../guide/app-types.md) and [Deployment](../guide/deployment.md) for details.

On an upgraded Void platform, an accepted deployment continues if the CLI disconnects. The CLI automatically reconnects to its progress. Pressing Ctrl+C stops observation; use `void project cancel` to request cancellation and `void project status` to inspect the result. If interrupted execution requires recovery, wait for its result before deploying again.

For an existing Void Worker, `void deploy` can link the Worker and migrate its root Cloudflare config. Keep the first deployment focused on the existing app. See [Deploy an existing Worker](../integrations/cloudflare.md#deploy-an-existing-worker) for requirements and the ISR cache choice.

For Drizzle projects, deploy performs a read-only schema drift check. If a new migration would be generated, deploy stops and tells you to run `void db generate`, review the migration, commit it yourself, and rerun `void deploy`.

| Flag                            | Purpose                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `--platform <cloudflare\|void>` | Override the platform stored in `.void/project.json`                                               |
| `--project <name>`              | Target a specific Void project by slug; not supported with `--platform cloudflare`                 |
| `--dir <path>`                  | Deploy a pre-built static directory (skips build)                                                  |
| `--spa`                         | Use SPA mode instead of SSG for static deploys                                                     |
| `--skip-build`                  | Skip the build step; on Cloudflare this is supported for static/SPA/SSG deploys only               |
| `--require-email`               | Fail when email cannot be set up instead of deploying without it; requires `--platform cloudflare` |
| `--atomic`                      | Publish an existing Durable Object Worker directly; readiness is checked after traffic changes     |
| `--debug`                       | Mirror the structured deploy log to stderr (also written to `~/.void/logs/`)                       |

`--atomic` applies to one deployment. For an existing Durable Object Worker that consistently cannot stage, set `deploy: { cloudflare: { mode: 'atomic' } }` in `void.config.ts` so plain `void deploy` uses atomic publication. The default is `staged`.

Every deploy writes a JSONL log to `~/.void/logs/`. Failures print the log path and relevant details. Use `--debug` or `VOID_DEPLOY_DEBUG=1` to mirror it to stderr.

Keep credentials out of build commands and register them as CI secrets so your CI provider can mask them in logs.

Platform resolution precedence:

1. `--platform <cloudflare|void>`
2. `platform` in `.void/project.json`
3. Void for projects initialized by an older SDK without a saved platform

Selecting Skip deployment setup stores `"platform": "none"`; a later `void deploy` stops with guidance until a platform override is provided.

For the Void platform, project resolution precedence is:

1. `--project <name>`
2. `VOID_PROJECT`
3. linked project in `.void/project.json`

If no project is linked and no override is provided, CLI prompts to link or create one. In CI (non-TTY), `void deploy` errors out instead — set `VOID_PROJECT` or pass `--project <slug>`.

### `void deploy --platform cloudflare`

Build and deploy to your Cloudflare account using `void.config.ts`:

```sh
void deploy --platform cloudflare
void deploy --platform cloudflare --require-email   # fail instead of deploying without email
```

Void signs you in through your browser when needed and saves the selected account. In CI, set `CLOUDFLARE_API_TOKEN` and, if the token can access several accounts, `CLOUDFLARE_ACCOUNT_ID`.

| Option or setting              | Cloudflare behavior                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `--dir`, `--spa`               | Deploy static output through a small Worker and Workers Assets                         |
| `--skip-build`                 | Reuse existing static, SPA, or SSG output; unavailable for Worker apps                 |
| `--project`                    | Unavailable; the Worker and account come from `void.config.ts` and `void.lock.json`    |
| Named environments             | Unavailable; use the top-level `cloudflare` config                                     |
| `CLOUDFLARE_WORKERS_SUBDOMAIN` | Needed in fresh CI when versions have no preview URL; cached locally after a deploy    |
| `--require-email`              | Fail instead of deploying without email when the email step cannot run, as in CI       |
| `DATABASE_URL`                 | Required in the deploy environment for PostgreSQL or MySQL provisioning and migrations |

The token needs Workers Scripts: Edit, read access to bound resources, and edit access to products Void provisions. Commit `void.lock.json` after the first deploy before using other machines or CI.

Use `void secret put <NAME>` for production server values. Local `.env` values are never deployed. Run `void db generate` and commit schema changes before deploying.

Sandbox requires [Workers Paid](https://dash.cloudflare.com/?to=/:account/workers/plans), Docker, and Containers access. API tokens need Account / Containers: Edit and Account / Cloudchamber: Edit.

For email, set `email.from` and run `void email setup --platform cloudflare` locally. Commit the lock file and pass `--require-email` in CI. See [Email setup](../guide/email.md#your-own-cloudflare-account).

For Access credentials, Hyperdrive permissions, readiness, and rollback, see [Cloudflare deployment](../integrations/cloudflare.md#deploy-to-your-own-cloudflare-account).

## Database

### `void db push`

Apply your Drizzle schema directly to the development database without creating migration files. D1 updates the local database; PostgreSQL and MySQL use `DATABASE_URL` from `.env`.

Use this for quick schema iteration while prototyping. Before deploying, generate and review migration files with `void db generate`.

### `void db generate`

Generate SQL migration files from schema changes.

Compares your schema with the last Drizzle snapshot and writes migrations under `db/migrations/`. It includes Void-managed auth tables and configured auth plugins, even without an application schema. Review and commit the generated files before deploying.

For SQLite, Void checks that the migration history applies to a fresh database. If generation fails this check, the previous SQL, snapshots, and journal are restored. If an existing migration fails, repair that unapplied migration first: rerunning generation compares snapshots and does not repair existing SQL. This check does not verify that a migration preserves existing data; review table rebuilds and foreign-key actions carefully.

### `void db status`

Show migration status. Displays which migrations are applied or pending locally, then uses the saved deployment target for remote status: the hosted API for Void projects, the pinned D1 database and its configured migration table for direct Cloudflare SQLite projects, or the shell `DATABASE_URL` for direct Cloudflare PostgreSQL/MySQL projects. If the remote credential or service is unavailable, local status is still shown.

### `void db reset`

Drop the local D1 database and re-apply all migrations. Does not affect the remote database.

### `void db seed`

```
void db seed [--file <path>]
```

Reset the local database, re-apply all migrations, then execute a seed file.

If `--file` is omitted, Void looks for default seed files in this order: `db/seed.ts`, `db/seed.mts`, `db/seed.js`, `db/seed.mjs`, `db/seed.sql`.

If more than one default seed file exists, the CLI stops and asks you to pass `--file <path>`.

Programmatic seed modules must export either a default function or a named `seed` function.

### `void db execute`

```
void db execute <sql>
void db execute --file <path>
void db execute --remote <sql>
```

Run ad-hoc SQL against the database. Provide SQL inline or from a file. SELECT queries display results as a formatted table; other statements execute silently.

By default, targets the local database. Pass `--remote` to run against the deployed database selected in `.void/project.json`:

- **Void platform D1 projects**: routes the query through the selected platform's registered proxy using your auth token. Void Cloud's proxy is `proxy.void.cloud`; a self-hosted platform uses its own proxy URL.
- **Direct Cloudflare D1 projects**: invokes Cloudflare against the pinned D1 binding from `void.config.ts` or `void.lock.json`.
- **Hosted PostgreSQL and MySQL projects**: fetches the stored connection string from the platform and connects directly.
- **Direct Cloudflare PostgreSQL and MySQL projects**: uses `DATABASE_URL` from the current shell; Cloudflare cannot return the password from Hyperdrive.

For destructive statements (`DELETE`, `UPDATE`, `DROP`, etc.) when running in a TTY, you will be prompted to confirm before the query is sent to the deployed database. Non-TTY environments (CI) skip the prompt.

### `void db migrate`

```
void db migrate [--remote]
```

Apply pending migrations to the local database without resetting. Unlike `void db reset`, this preserves existing data and only runs migrations that haven't been applied yet.

Pass `--remote` to apply pending migrations to the saved target. Hosted projects require a Void login and link. Direct Cloudflare D1 projects use the binding's configured migration directory, table, and pattern; direct PostgreSQL and MySQL projects use the shell `DATABASE_URL`.

### `void db studio`

```
void db studio [--remote]
```

Open [Drizzle Studio](https://orm.drizzle.team/docs/drizzle-kit-studio) for the database. Launches a web-based GUI for browsing and editing your data.

By default, targets the local database. Pass `--remote` to open Studio against the deployed database:

- **PostgreSQL and MySQL projects**: fetch the stored connection string from the platform and open Studio against it. If the URL isn't stored yet, run `void db set-url` first.
- **D1 projects**: remote Studio is not yet supported. Use `void db execute --remote` for ad-hoc queries against your deployed D1 database.

On direct Cloudflare PostgreSQL/MySQL targets, remote Studio uses `DATABASE_URL` from the current shell. Direct D1 Studio remains unsupported; use `void db execute --remote`.

### `void db rename-migrations`

Rename existing migrations from the old numeric prefix format (`0001_name.sql`) to timestamp-based format (`20260410161500_name.sql`). Updates local tracking table and remote records if logged in with a linked project.

### `void db connect`

Connect an existing PostgreSQL/MySQL database or provision one through an adapter:

```sh
void db connect 'postgresql://user:password@host/database'
NEON_API_KEY=... void db connect --provider neon --name my-app
void db connect --provider @acme/void-db-provider --region region-id
```

The command saves `DATABASE_URL` in `.env`. When authenticated with a linked Void project, it also updates the encrypted deployment URL; pass `--local-only` to skip that sync. `neon` is built in. Other adapters are project dependencies or local modules exporting a `DatabaseProviderAdapter` from `void/database-provider`.

Provider-created credentials are never printed. For direct Cloudflare deploys, configure the same URL as a protected `DATABASE_URL` in the shell or CI environment that runs deploy.

### `void db set-url`

Update the PostgreSQL or MySQL connection string for deployment. Available for projects with `"database": "pg"` or `"database": "mysql"`.

Prompts for a connection string and sends it to the platform API to create or update the Hyperdrive configuration.

### `void db export`

```
void db export [--output <path>] [--no-data] [--no-schema] [--table <name>]
```

Dump the local database as SQL. Outputs to stdout by default (pipeable), or to a file with `--output`.

Data exports preserve SQLite AUTOINCREMENT and PostgreSQL SERIAL and identity counters, including IDs consumed by deleted rows. SQLite schema exports include indexes, views, and triggers. PostgreSQL schema exports preserve column types, generated columns, identity definitions, serial sequences, constraints, and indexes. `--no-schema` restores counter values into an existing schema; `--no-data` starts counters at their schema-defined starting values.

For PostgreSQL schemas with views, triggers, custom types, functions, or standalone sequences, use `pg_dump` for a complete backup. `void db export` reports these objects before writing a schema dump.

| Flag              | Purpose                            |
| ----------------- | ---------------------------------- |
| `--output <path>` | Write to a file instead of stdout  |
| `--no-data`       | Schema only (no INSERT statements) |
| `--no-schema`     | Data only (no CREATE TABLE)        |
| `--table <name>`  | Export a single table              |

## Code Generation

### `void gen model`

```
void gen model <name> [columns...]
```

Scaffold a Drizzle table, list and create routes, and a route to fetch one row by ID.

```sh
void gen model posts title:string body:text published:boolean
```

Creates:

- `db/schema/posts.ts`: a table with `id`, `createdAt`, `updatedAt`, and your columns
- An export from `db/schema.ts`
- `routes/api/posts/index.ts`: `GET` for list and `POST` for insert with validation
- `routes/api/posts/[id].ts`: `GET` by id with `404` handling
- Regenerated `.void/db.d.ts`

The generated routes automatically detect your validation library from `package.json` (`valibot`, `zod`, or `arktype`). If none is found, you will be prompted to choose one or skip validation. Run `void db push` to apply the schema locally, or `void db generate` to create migrations before deploying.

Column format: `name:type` or `name:type?` (nullable). Types: `string`, `text`, `datetime`, `integer`, `boolean`, `real`, `blob`.

Model names must be lowercase alphanumeric with underscores (e.g. `posts`, `user_roles`). Existing files are never overwritten.

### `void gen migration`

```
void gen migration <name>
```

Create an empty migration file with a timestamp prefix (`YYYYMMDDHHMMSS`).

```sh
void gen migration add_avatar_to_users
# → db/migrations/20260410161500_add_avatar_to_users.sql
```

Existing projects using the old numeric prefix (`0001_`, `0002_`, ...) can rename with `void db rename-migrations`.

### `void gen route`

```
void gen route <path> [--methods get,post,...]
```

Create a route file with `defineHandler` exports. Defaults to GET.

```sh
void gen route api/health
void gen route api/users --methods get,post,delete
```

Creates `routes/<path>.ts` with an exported handler for each method. Supported methods: `get`, `post`, `put`, `patch`, `delete`.

### `void gen middleware`

```
void gen middleware <name>
```

Create a numbered middleware file with `defineMiddleware` default export.

```sh
void gen middleware auth
# → middleware/01.auth.ts (or 02, 03, etc.)
```

The prefix is auto-detected from existing middleware files.

### `void gen ssr`

```
void gen ssr [--react | --vue | --svelte | --solid]
```

Scaffold SSR entry points and a minimal App component for your framework.

Creates three files:

- `src/main.ssr.{tsx,ts}`: server entry with `defineRender`
- `src/main.client.{tsx,ts}`: client entry with hydration
- `src/App.{tsx,vue,svelte}`: minimal interactive component

If no flag is provided, the framework is auto-detected from `package.json` dependencies.

### `void gen cron`

```
void gen cron <name>
```

Create a cron job file in `crons/` with `defineScheduled` and a placeholder cron expression.

```sh
void gen cron hourly-sync
```

### `void gen queue`

```
void gen queue <name>
```

Create a queue consumer file in `queues/` with `defineQueue`, a `Message` interface, and commented-out batch options.

```sh
void gen queue emails
```

## Secrets

### `void secret list`

```
void secret list [--project <name>]
```

List production secret names for the saved target. Secret values are never printed. Direct Cloudflare targets query the Worker named in `void.config.ts`; `--project` is hosted-only.

### `void secret put`

On hosted projects, secret writes and deletes return a retryable conflict while a deployment or rollback is in progress. Wait for that operation to finish and retry; the rejected operation leaves the stored secret unchanged.

```
void secret put <name> [--project <name>]
void secret put <name=value> [--project <name>]
```

Value input modes:

- inline: `void secret put API_KEY=abcd`
- prompt (TTY): `void secret put API_KEY` (masked input)
- stdin: `echo -n "abcd" | void secret put API_KEY`

On a direct Cloudflare target, the value is sent to Cloudflare over stdin and stored as an encrypted Worker secret.

### `void secret sync`

```
void secret sync <file> [--project <name>]
```

Upload production server values from a dotenv file stored outside your project. Include only keys declared in `env.ts`; leave out local development credentials and public `VITE_*` values.

```sh
void secret sync /secure/path/production.env
```

Existing remote secrets absent from the file are kept. Every entry must be a server key declared in `env.ts`, and its value must pass validation.

### `void secret delete`

```
void secret delete <name> [--project <name>]
```

Secret commands use the platform saved in `.void/project.json`. Hosted project resolution follows the same order as deploy (`--project`, env var, linked project). Direct Cloudflare targets reject `--project` and use the pinned root Cloudflare config.

## Env Schema

### `void env check`

```
void env check [--remote]
```

Without `--remote`, validate `.env` plus the shell for local development. With `--remote`, validate build-shell client values and the remote server-secret names. Exits non-zero if a required key is missing or a readable value is invalid.

### `void env types`

```
void env types
```

Regenerate `.void/env.d.ts` from `env.ts`. Normally happens automatically on dev server start and HMR; use this command after a fresh clone or to refresh stale types in non-dev contexts.

::: tip Deploy validation
`void deploy` runs the same schema validation automatically (with remote secrets) and refuses to upload if any required key is missing — no need to call `env check` separately when deploying.
:::

See [Environment Variables](../guide/env-vars.md) for the full guide.

## GitHub

Deploy-on-GitHub works from **any** Void login — Google, GitHub, or other SSO. The first time you connect GitHub, Void links your GitHub identity to your current account (a one-time step, independent of how you logged in); it never creates a second account.

### `void github link`

```
void github link
```

Link your signed-in Void account to GitHub through your browser. `void github install` does this automatically when needed.

::: warning Existing GitHub sign-in
A GitHub identity can belong to only one Void account. If it is already linked elsewhere, sign in to that Void account or authorize a different GitHub identity.
:::

### `void github install`

```
void github install
```

Open the GitHub App install page in your browser. If your account has no linked GitHub identity yet, `void github install` first runs the GitHub link automatically (browser authorize), then continues. After installing, run `void github connect` to link a repository to your project.

### `void github installations`

```
void github installations
```

List all GitHub App installations linked to your account. Each entry includes the `[id: <installation_id>]` needed for `--installation` in non-interactive use.

### `void github join`

```
void github join
```

Join an existing organization installation through your browser. `void github connect` can do this automatically in an interactive terminal. Run `join` locally before non-interactive setup when needed.

Requires a signed-in Void account and organization-installation sharing enabled by your platform. Use `void github installations` to find the installation ID.

### `void github connect`

```
void github connect [project] [options]
```

Connect a GitHub repository to a Void project for automatic deploys. On every push to the configured branch, Void builds and deploys your project automatically.

The CLI opens your browser when it needs GitHub authorization. If no installation is available, run `void github install`.

**Options**

| Flag                  | Description                                                                       |
| --------------------- | --------------------------------------------------------------------------------- |
| `--project <name>`    | Project name (alias for the positional argument)                                  |
| `--installation <id>` | GitHub App installation ID (required when you have multiple installations)        |
| `--repo <owner/repo>` | Repository full name — required unless the installation grants exactly one repo   |
| `--branch <name>`     | Branch to deploy from — **required in non-interactive mode**                      |
| `--executor <type>`   | Build executor: `container` (default) or `github_actions`                         |
| `--workflow <path>`   | Authorized deploy workflow file — defaults to `.github/workflows/void-deploy.yml` |

Choose `container` for platform builds or `github_actions` for a deployment workflow. The CLI prompts for the executor and, for GitHub Actions, the workflow file. Pass the corresponding flags to skip those prompts.

The workflow must be a `.yml` or `.yaml` file under `.github/workflows/`. Only that workflow can obtain the project's OIDC deployment token. Prefer a dedicated deployment workflow.

For CI, supply the project and branch, plus the installation and repository when they cannot be selected automatically. Organization connections require repository authorization in a local browser first.

```
void github connect my-app \
  --installation 42 \
  --repo owner/my-app \
  --branch main
```

**Project resolution** follows the same order as deploy: positional / `--project`, `VOID_PROJECT`, linked project (`.void/project.json`).

You can connect only repositories your GitHub account can access.

A project has one GitHub connection. Running `void github connect` on a project that is already connected fails. To connect a different repository, run `void github disconnect` first.

### `void github update`

```
void github update [project] [options]
```

Change the branch, executor, or workflow for an existing connection. To change the repository, disconnect and reconnect.

**Options**

| Flag                | Description                                                      |
| ------------------- | ---------------------------------------------------------------- |
| `--project <name>`  | Project name (alias for the positional argument)                 |
| `--branch <name>`   | New branch to deploy from                                        |
| `--executor <type>` | New build executor: `container` or `github_actions`              |
| `--workflow <path>` | New authorized deploy workflow file (under `.github/workflows/`) |

The CLI prompts for new settings using the current values as defaults. In CI, pass at least one of `--branch`, `--executor`, or `--workflow`.

```
void github update my-app --executor github_actions
```

**Project resolution** follows the same order as deploy: positional / `--project`, `VOID_PROJECT`, linked project (`.void/project.json`).

### `void github status`

```
void github status [project]
```

Show the connected repository, branch, executor, and workflow. Container builds do not use the workflow file.

**Options**

| Flag               | Description                                      |
| ------------------ | ------------------------------------------------ |
| `--project <name>` | Project name (alias for the positional argument) |

```
void github status my-app
```

**Project resolution** follows the same order as deploy: positional / `--project`, `VOID_PROJECT`, linked project (`.void/project.json`).

### `void github disconnect`

```
void github disconnect [project]
```

Disconnect a project from its GitHub repository, stopping automatic deploys. Any in-flight builds for the project are cancelled (their deploy tokens are revoked) before the connection is removed. If the project has no connection, it reports that and exits successfully. To point a project at a different repository, disconnect first, then run `void github connect`.

You are asked to confirm before anything is removed. Pass `--yes` to skip the prompt; `--yes` is **required** in a non-interactive shell (CI), where there is no prompt to answer.

**Options**

| Flag               | Description                                                       |
| ------------------ | ----------------------------------------------------------------- |
| `--project <name>` | Project name (alias for the positional argument)                  |
| `--yes`            | Skip the confirmation prompt (required in non-interactive shells) |

```
void github disconnect my-app --yes
```

**Project resolution** follows the same order as deploy: positional / `--project`, `VOID_PROJECT`, linked project (`.void/project.json`).

## Build

Inspect Deploy-on-GitHub builds.

### `void build logs`

```
void build logs [build] [--follow] [--output <file>] [--project <slug>]
```

Stream, tail, or download the build logs for a **container** build. With no
`[build]` argument, targets the project's most recent build.

| Flag                     | Purpose                                                                   | Default |
| ------------------------ | ------------------------------------------------------------------------- | ------- |
| `--follow`, `-f`         | Live-tail: poll until the build finishes and its final logs are captured. | off     |
| `--output <file>`, `-o`  | Write logs to a file instead of stdout (appends while following).         | stdout  |
| `--project <slug>`, `-p` | Target project.                                                           | linked  |

**Project resolution** follows the same order as deploy: positional / `--project`,
`VOID_PROJECT`, linked project (`.void/project.json`).

Builds run on **GitHub Actions** keep their logs on GitHub — the command prints
the Actions run URL instead of streaming. Only the last 10,000 log lines of a
container build are retained.

Following waits for the platform to confirm the final log tail. If the platform cannot confirm it, upgrade the platform runtime or read the retained logs without `--follow`. An unfinished final tail reports an error after two minutes; retry to recover it.

Examples:

```
void build logs                     # print the latest build's logs
void build logs -f                  # follow the latest build until it finishes
void build logs bld_123 -o build.log  # download a specific build's logs
```

## Custom Domains

### `void domain add`

```
void domain add <hostname> [--project <name>]
```

Add a custom domain to the saved target. Hosted Void projects print the DNS records needed for SaaS hostname validation. Direct Cloudflare projects add a `custom_domain` route and immediately synchronize only the route configuration, leaving cron, queue, and workflow triggers unchanged; Cloudflare manages the DNS record and TLS certificate in a zone on the pinned account. Convert a legacy singular `route` field to a `routes` array first so adding the domain cannot shadow the existing route.

> Wildcard custom hostnames (`*.example.com`) are not supported — register each subdomain individually.

### `void domain delete`

```
void domain delete <hostname> [--project <name>]
```

Direct Cloudflare projects apply the change immediately. Deleting the final custom domain uses your browser session from `void cloudflare login` or an API token with Workers Scripts: Edit permission. If Cloudflare rejects the change, Void attempts to restore the previous domain configuration and reports whether recovery succeeded.

### `void domain list`

```
void domain list [--project <name>]
```

List all custom domains. Hosted projects show active/pending state from the platform; direct Cloudflare projects list the custom-domain routes currently configured in `void.config.ts`.

### `void domain status`

```
void domain status <hostname> [--project <name>] [--verbose]
```

Show domain verification and TLS certificate status, including DNS records to configure and any required action. Domains activate automatically once verification and certificate issuance finish.

For direct Cloudflare projects, status reports whether the route is present in the Void Cloudflare config. It does not claim to inspect remote certificate issuance; Cloudflare owns that state and exposes it in the dashboard. `--project` is hosted-only.

## Email

Inspect email usage and manage the recipients a project is allowed to send to. See [Email](../guide/email.md) for the runtime API.

Project resolution for email commands follows the same order as deploy (`--project`, `VOID_PROJECT`, linked project). `void email setup` and `void email status --platform cloudflare` are the exception: they act on your own Cloudflare account through your Cloudflare sign-in (`void cloudflare login`) and need no Void project.

### `void email usage`

```
void email usage [--project <name>]
```

Show the current month's recipient attempts and inbound receipts, the monthly attempt limit, and how much of it is left. Reserved submissions count toward the limit; started attempts remain charged even if delivery fails or its outcome is unknown. A suspended project is flagged in the output.

### `void email logs`

```
void email logs [--limit <n>] [--project <name>]
```

Show recent email operation metadata retained for 30 days: timestamp, direction, operation ID, recipient, and state. `--limit` accepts 1–100. Subjects, bodies, and attachments are not stored. Provider acceptance does not confirm mailbox delivery; inspect unknown outcomes before retrying.

### `void email destinations`

```
void email destinations [--project <name>]
```

List the project's recipient addresses and their state (`verified`, `pending`, or `failed`). Outbound mail is only delivered to verified addresses.

### `void email allow`

```
void email allow <address> [--project <name>]
```

Add one recipient to the project's destination list. Cloudflare emails that address a verification link — the recipient clicks it, with no Void or Cloudflare account required. Then run `void email destinations`: the listing is what records the click, and until it has, a send to that address returns `UNVERIFIED_DESTINATION` for that recipient. If the link did not arrive or has expired, run `void email allow <address>` again while the address is still pending — the CLI re-sends the link, or tells you how to get a fresh one.

The project owner's email is added automatically when the project is created, so it skips this step but not the verification: unless Cloudflare already had it verified for an earlier project of yours, click the link it mailed and run `void email destinations`; until then a send to yourself returns `UNVERIFIED_DESTINATION` for that recipient.

### `void email disallow`

```
void email disallow <address> [--project <name>]
```

Remove one recipient from the project's destination list. New sends to that address are refused immediately; previously admitted attempts may finish. No deploy is involved.

### `void email domain`

```
void email domain <add|status|list|sync|rotate-secret|remove> [<domain>] [--project <name>]
```

Send and receive at your own domain on a Cloudflare zone you own, registered to the project. Void platform only — on your own Cloudflare account the mail domain comes from `email.from` instead (see `void email setup`). The walkthrough is [Your own domain on the platform](../guide/email.md#your-own-domain-on-the-platform).

#### `void email domain add`

```
void email domain add <domain> [--project <name>]
```

Register an exact domain with the project using a scoped Cloudflare API token. The CLI opens a token template, accepts a masked paste or newly copied token, and asks you to confirm account and zone restrictions. Credentials are encrypted for the zone connection. Custom inbound email requires a Cloudflare zone apex because its catch-all does not cover subdomains. Foreign MX records and catch-alls are preserved; use another zone apex or the platform shared mail address when the apex already receives mail. Each custom apex belongs to one project. Setup returns an operation ID so an interrupted request can be checked without restarting the operation.

#### `void email domain status`

```
void email domain status <domain> [--project <name>]
```

Show the recorded inbound, outbound, and management readiness, observation times, and latest operation. Use `sync` to reconcile setup and refresh readiness.

#### `void email domain list`

```
void email domain list [--project <name>]
```

List the project's registered email domains and readiness.

#### `void email domain sync`

```
void email domain sync <domain> [--project <name>]
```

Reconcile the domain connection and refresh readiness. Sync does not rotate its secret. A blocked or uncertain operation exits unsuccessfully and names the operation to inspect.

#### `void email domain rotate-secret`

```sh
void email domain rotate-secret <domain> [--project <name>]
```

Rotate the connection secret shared by this domain and other domains on the same zone. Inbound delivery must be ready; run `void email domain sync <domain>` first if setup is incomplete. Inspect an uncertain result before retrying.

#### `void email domain remove`

```
void email domain remove <domain> [--project <name>]
```

Disable the domain assignment and record cleanup. Zone resources used by another domain remain available. Unfinished or uncertain cleanup remains recorded until it can be reconciled safely.

### `void email status`

```
void email status --platform cloudflare
```

Check the domain configured in `email.from`: permissions, DNS, routing, sending, handler addresses, and the email binding. Exits unsuccessfully when setup is incomplete. Workers Free setup can be ready with sending limited to verified destinations; run `void email setup --platform cloudflare` after upgrading to Workers Paid.

Without `--platform cloudflare` (or with `--platform void`) the command is not available yet; on the Void platform use `void email usage` and `void email destinations`.

### `void email setup`

```
void email setup --platform cloudflare
```

Set up email before deploying from CI. Requires `email.from` in `void.config.ts`, an interactive terminal, and Cloudflare email permissions.

Void shows the planned DNS, routing, plus-addressing, and sending changes and asks before applying them. Commit `void.lock.json`, then run `void deploy --platform cloudflare --require-email` in CI.

On Workers Free, inbound mail and sends to verified recipients remain available. Run this command again after upgrading to Workers Paid to enable arbitrary recipients. See [Email setup](../guide/email.md#your-own-cloudflare-account).

## Agent

### `void init --agents`

Adds Void instructions to `AGENTS.md` and links skills for detected coding agents. Existing instructions outside the Void block are preserved.

If no supported agent is detected, `AGENTS.md` links to the bundled docs. See [Coding Agents](../integrations/agents.md).

## Environment variables

| Variable       | Purpose                                                                   | Default |
| -------------- | ------------------------------------------------------------------------- | ------- |
| `VOID_TOKEN`   | Auth token override instead of saved config                               | none    |
| `VOID_PROJECT` | Default project slug for deploy, secret, domain, and cache purge commands | none    |
