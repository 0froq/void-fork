---
outline: deep
---

# Developing a Void Platform

The framework, CLI, and platform live in one repository. You can change the platform, test it locally, and deploy a runtime built from your fork into your own Cloudflare account.

If you want to run the released platform without changing its implementation, start with [Install a Void Platform](./self-hosted-platform.md). Use [Platform Administration](./platform-administration.md) for managing an installed platform.

## Setting Up the Repository

Clone your fork and install the workspace dependencies with Vite+:

```sh
git clone https://github.com/your-org/void.git
cd void
vp install
vpr install:void-dev
void-dev --help
```

Use the Node.js version recorded in `.node-version`. The workspace uses public npm packages; a GitHub Packages token is not required.

`install:void-dev` builds the CLI, shared packages, and platform runtime, then makes this checkout's built CLI globally available as `void-dev`. Public packages export their built files, so run `vp run build:core` after later source changes to refresh the alias. The installer refuses to replace an unrelated global command. Remove only this checkout's alias with `vpr uninstall:void-dev`. All commands in this guide run from the repository root.

## Finding the Implementation

| Directory                                            | Purpose                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/void`                                      | Framework, application runtime, and CLI                              |
| `packages/platform`                                  | Installer contracts, packaged Workers, and platform migrations       |
| `packages/deploy-core`, `packages/deploy-cloudflare` | Shared deployment contracts and Cloudflare upload code               |
| `platform/packages/api`                              | Users, projects, deployments, provisioning, and administrator API/UI |
| `platform/packages/dispatch`                         | Application routing and static assets                                |
| `platform/packages/proxy`                            | AI, remote bindings, and revalidation                                |
| `platform/packages/tail`                             | Runtime log ingestion                                                |
| `platform/packages/dashboard`                        | Dashboard source and local UI components in `ui/`                    |

The `@voidcloud/*` names identify workspace implementation packages. Their `private: true` flags prevent publishing those packages to npm. Deployable core Workers are bundled into the public `@void/platform` package.

The core installer creates the API, dispatch, proxy, and tail Workers. The dashboard and managed GitHub build services are available in the source tree but are not included in that installation. Adding an optional service requires its infrastructure, bindings, authentication, and capability configuration together.

## Running the API Locally

Start a local PostgreSQL server and make `psql` and `pg_isready` available on your path. Then create the development database, apply its migrations, and seed an administrator:

```sh
vp run --filter @voidcloud/api setup --admin-email dev@example.com
vp run --filter @voidcloud/api dev --local --enable-containers=false --host localhost --port 8787
```

The command disables the optional build containers, so basic API and admin work
does not require Docker. To develop managed builds, install Docker and run the
API with containers enabled.

Open `http://localhost:8787/admin/`. Setup writes local development values to the API and dashboard `.dev.vars` files, including the development authentication bypass and local database connection. Those files are ignored by Git. Production installations get separate credentials through the installer.

The API's development bypass lets you work on the browser admin UI without setting up OAuth. Operator CLI sessions still require administrator authentication; they do not use the browser bypass.

## Running the Dashboard Locally

The dashboard is a separate source app. After API setup, start it in another terminal:

```sh
vp run --filter @voidcloud/dashboard dev
```

Its local `.dev.vars` should point to the API you started:

```dotenv
API_URL=http://localhost:8787
SITE_DOMAIN=apps.example.com
```

Open the Vite URL and choose **Dev login (local API)**. That button appears for a localhost API and uses the local development sign-in endpoint.

You can also point the dashboard at an API that you operate. If Cloudflare Access protects that API, install `cloudflared` and opt into the dashboard's local token helper with matching origins:

```dotenv
API_URL=https://platform.example.com
CF_ACCESS_APP_URL=https://platform.example.com
SITE_DOMAIN=apps.example.com
```

The helper refreshes an Access session before the dev server starts. A configured `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` pair can be used for automation instead. This is dashboard development configuration; Access credentials are separate from platform login credentials.

## Testing Changes

Run tests for the area you changed while developing:

```sh
vp test run platform/packages/api/test/integration/operator-auth.test.ts
vp run check
```

Before preparing a release, build the packages and run the complete checks:

```sh
vp run build:all
vp run check
vp lint
vp run lint:platform
vp fmt --check
vp test run
vp run build:docs
```

Platform integration tests use their local test database by default. To test against PostgreSQL, set `VOID_TEST_DATABASE_URL` to a disposable database: these tests clear tables between cases.

To exercise a deployed application, deploy a disposable copy of `playground/kitchen-sink` and pass its URL as `SMOKE_URL` to the smoke test described in `platform/scripts/kitchen-sink-smoke-test.md`. That test creates and removes application data.

## Deploying Your Runtime

Build the runtime. From a Git checkout, the build automatically records the current commit in the runtime manifest. An uncommitted checkout is recorded with a `-dirty` suffix:

```sh
vp run build:core
```

Build systems may set `VOID_PLATFORM_SOURCE_REVISION` when they need to override automatic detection with another immutable revision. A source archive without Git metadata builds normally but leaves the revision unrecorded.

The runtime is written to `packages/platform/dist/runtime`. Use the built CLI to preview a new installation from those files:

```sh
void-dev platform install \
  --name my-team \
  --application-domain example.app \
  --zone example.app \
  --runtime packages/platform/dist/runtime \
  --plan
```

Before applying the plan, complete the [first-install walkthrough](./self-hosted-platform.md). Run the command without `--plan` to install. For testing before your domain is ready, replace `--application-domain` and `--zone` with `--workers-dev`; PostgreSQL and the runtime/GitHub/R2 credentials are still needed. Use `void-dev` in place of `void` and keep `--runtime packages/platform/dist/runtime` on install and resume commands. For an interrupted installation, keep that runtime build available until it completes.

Later, run `void-dev platform domain set example.app`. Domain setup uses the existing installed runtime and needs no `--runtime`, rebuild, or app redeploy. It keeps the platform API URL and original workers.dev app URLs available.

For an existing installation, preview an upgrade using its connection ID:

```sh
void-dev platform upgrade <installation-id> \
  --runtime packages/platform/dist/runtime --plan
```

Then run it without `--plan` to apply the upgrade. Source-built runtimes go through the same artifact, database, ownership, and health checks as released runtimes. The CLI preserves a disabled installation's state and records the source revision in its installation checkpoint.

## Changing the Platform Schema

The schema lives in `platform/packages/api/src/schema.ts`. Generate a migration after changing it:

```sh
vp run --filter @voidcloud/api db:generate
```

Review the generated SQL and migration journal before committing them. Released migrations are append-only. An upgrade applies new migrations while the previous Workers may still serve requests, so schema changes must remain compatible with that code.

`platform/packages/api/drizzle/compatibility.json` records which earlier runtimes have been verified against the new schema. Add an edge only after testing that compatibility. The runtime build checks that the migration files and recorded schema history agree. See `packages/platform/README.md` for the manifest contract.

## CI in a Fork

The uncredentialed test workflows use GitHub-hosted runners in forks. They build and test the workspace without requiring Void Cloud accounts, tokens, or deployment access.

If your fork has a released platform version, set the repository variable
`VOID_PLATFORM_PRODUCTION_REF` to its immutable 40-character commit SHA. Platform
pull requests then create that version's database, seed representative user,
project, and encrypted-secret records, and apply the proposed migrations. The
check verifies existing data and runs the previous runtime against the upgraded
schema. Mutable branch or tag names are rejected.

Without an explicit SHA, required compatibility checks use the latest successful
GitHub deployment to `Prod` (or `VOID_PLATFORM_PRODUCTION_ENV`). They require
read access to deployment history and stop if no completed deployment is found.
Advancing the production branch does not change the selected baseline. Fork
workflows that call platform CI must grant `deployments: read` alongside
`contents: read`.

The upstream repository also contains workflows for deploying Void Cloud and publishing the official npm packages. Forks should configure their own release workflow around the built CLI and `platform upgrade --runtime`; the [source-build CI example](./self-hosted-platform.md#continuously-deploy-a-source-build) shows the required inputs. Keep production credentials in protected environments restricted to the appropriate release refs.

Public releases use matching versions for the CLI, scaffolder, adapters, and
packaged platform. The publish workflow rejects mismatched versions and previously
unpublished `void` versions that npm cannot reuse. Stable versions use `latest`;
prereleases use their named channel, such as `beta` or `rc`. Numeric prereleases
use `next`. The scaffolder installs its exact matching CLI version, so
`create-void@beta` cannot silently select the stable CLI. Packaged platform
runtimes record the release commit as their source revision.

Publishing requires both SDK CI and platform CI, including the platform unit and
API integration suites. Release tags also run the Windows SDK checks; a passing
SDK-only build cannot publish a changed control plane.

For implementation history, use the design archive at `platform/meta/design-docs/README.md`. Its proposals explain earlier decisions; the source and current guides define the supported behavior.
