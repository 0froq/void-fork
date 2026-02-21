---
outline: deep
---

# CLI

`vite-cloud` ships a CLI with two binaries:

- `vcc` (short)
- `vite-cloud` (alias)

Examples below use `vcc`.

## Binary invocation

`vcc` is a local binary from the `vite-cloud` package installed in your app, so outside of npm scripts, you will have to invoke it with `npx`, `pnpm`, `yarn`, or `bunx`.

Alternatively, you can add `./node_modules/.bin` to your `PATH` so that you can invoke `vcc` directly when you are in the root directory of your app.

**For brevity, we will used unprefixed `vcc` throughout the docs.**

:::warning ⚠️ Prefer local install
We do not recommend installing `vite-cloud` globally, because the CLI needs to be in sync with same version of the runtime framework. Always install `vite-cloud` locally as a dev dependency of your project.
:::

## Setup

### `vcc init`

```
vcc init [--tsconfig] [--github] [--agents]
```

Interactive setup wizard for adding vite-cloud to an existing project. Walks through:

1. **TypeScript** — creates or updates `tsconfig.json` (adds `extends .vite-cloud/tsconfig.json` and `vite-cloud/env` types)
2. **Agent instructions** — adds Vite Cloud framework instructions to `CLAUDE.md` or `AGENTS.md`
3. **Skills** — links vite-cloud skills to detected coding agents
4. **MCP config** — writes MCP server config for detected coding agents
5. **Demo code** — optionally scaffolds a migration, API route, and typed fetch example
6. **GitHub Actions** — optionally creates `.github/workflows/deploy.yml` with the correct package manager commands

Use flags to run individual steps without prompts:

| Flag         | Purpose                                                               |
| ------------ | --------------------------------------------------------------------- |
| `--tsconfig` | Only update `tsconfig.json`                                           |
| `--agents`   | Set up agent instructions, skills, and MCP config for detected agents |
| `--github`   | Only create GitHub Actions workflow                                   |

Flags can be combined. When any flag is provided, only the specified steps run and interactive prompts are skipped.

## Auth

### `vcc login`

OAuth login (GitHub or Google — you choose at the prompt). Saves token to `~/.vite-cloud/config.json`.

### `vcc logout`

Removes saved credentials.

### `vcc whoami`

Prints your current login.

### `vcc token`

Copies your auth token to the system clipboard. Useful for setting up CI secrets.

## Project commands

### `vcc projects`

List all your projects (slug, mode, URL).

### `vcc link [name]`

Link current directory to an existing project by slug, or select interactively if omitted. State is stored in `.vite-cloud/project.json`.

### `vcc delete [name]`

Permanently delete a project and all its resources (databases, KV namespaces, R2 buckets, deployments). Requires typing the project slug to confirm.

If `[name]` is omitted, uses the linked project.

## Deployment history

### `vcc list [name]`

Show the last 5 deployments for a project. Alias: `vcc ls`.

- If `[name]` is provided, looks up the project by slug
- Otherwise uses the linked project from `.vite-cloud/project.json`

## Deploy

### `vcc deploy`

```
vcc deploy [--project <name>] [--dir <path>] [--spa] [--skip-build]
```

Auto-detects your project type and chooses the right pipeline. See [App Types](./app-types.md) and [Deployment](./deployment.md) for details.

| Flag               | Purpose                                           |
| ------------------ | ------------------------------------------------- |
| `--project <name>` | Target a specific project by slug                 |
| `--dir <path>`     | Deploy a pre-built static directory (skips build) |
| `--spa`            | Use SPA mode instead of SSG for static deploys    |
| `--skip-build`     | Skip the build step (use existing build output)   |

Project resolution precedence:

1. `--project <name>`
2. `VITE_CLOUD_PROJECT`
3. linked project in `.vite-cloud/project.json`

If no project is linked and no override is provided, CLI prompts to link or create one.

## Database

### `vcc db status`

Show migration status. Displays which migrations are applied or pending locally. When logged in and linked to a project, also shows remote status.

### `vcc db reset`

Drop the local D1 database and re-apply all migrations. Does not affect the remote database.

### `vcc db seed`

```
vcc db seed [--file <path>]
```

Reset the local database, re-apply all migrations, then execute a seed file. Defaults to `migrations/seed.sql`. The seed file is excluded from migration collection — it's never deployed or applied as a migration.

### `vcc db execute`

```
vcc db execute <sql>
vcc db execute --file <path>
```

Run ad-hoc SQL against the local D1 database. Provide SQL inline or from a file. SELECT queries display results as a formatted table; other statements execute silently.

### `vcc db migrate`

```
vcc db migrate
```

Apply pending migrations to the local database without resetting. Unlike `vcc db reset`, this preserves existing data and only runs migrations that haven't been applied yet.

### `vcc db export`

```
vcc db export [--output <path>] [--no-data] [--no-schema] [--table <name>]
```

Dump the local database as SQL. Outputs to stdout by default (pipeable), or to a file with `--output`.

| Flag              | Purpose                            |
| ----------------- | ---------------------------------- |
| `--output <path>` | Write to a file instead of stdout  |
| `--no-data`       | Schema only (no INSERT statements) |
| `--no-schema`     | Data only (no CREATE TABLE)        |
| `--table <name>`  | Export a single table              |

## Code Generation

### `vcc gen model`

```
vcc gen model <name> [columns...]
```

Scaffold a complete model: migration file, CRUD API routes, and regenerated DB types in one command.

```sh
vcc gen model posts title:string body:text published:boolean
```

Creates:

- `migrations/NNN_create_posts.sql` — CREATE TABLE with `id` (autoincrement), your columns, and `created_at`
- `routes/api/posts/index.ts` — GET (list all) + POST (insert with validation)
- `routes/api/posts/[id].ts` — GET by id with 404 handling
- Regenerated `.vite-cloud/db.d.ts`

The generated routes automatically detect your validation library from `package.json` (valibot, zod, or arktype). If none is found, you'll be prompted to choose one or skip validation. See [Database — Scaffolding](./db.md#scaffolding) for the full type mapping.

Column format: `name:type` or `name:type?` (nullable). Types: `string`, `text`, `datetime`, `integer`, `boolean`, `real`, `blob`.

Model names must be lowercase alphanumeric with underscores (e.g. `posts`, `user_roles`). Existing files are never overwritten.

### `vcc gen migration`

```
vcc gen migration <name>
```

Create an empty migration file with auto-numbered prefix. The number is one greater than the highest existing migration.

```sh
vcc gen migration add_avatar_to_users
# → migrations/002_add_avatar_to_users.sql
```

### `vcc gen route`

```
vcc gen route <path> [--methods get,post,...]
```

Create a route file with `defineHandler` exports. Defaults to GET.

```sh
vcc gen route api/health
vcc gen route api/users --methods get,post,delete
```

Creates `routes/<path>.ts` with an exported handler for each method. Supported methods: `get`, `post`, `put`, `patch`, `delete`.

### `vcc gen middleware`

```
vcc gen middleware <name>
```

Create a numbered middleware file with `defineMiddleware` default export.

```sh
vcc gen middleware auth
# → middleware/01.auth.ts (or 02, 03, etc.)
```

The prefix is auto-detected from existing middleware files.

### `vcc gen ssr`

```
vcc gen ssr [--react | --vue | --svelte | --solid]
```

Scaffold SSR entry points and a minimal App component for your framework.

Creates three files:

- `src/main.ssr.{tsx,ts}` — server entry with `defineRender`
- `src/main.client.{tsx,ts}` — client entry with hydration
- `src/App.{tsx,vue,svelte}` — minimal interactive component

If no flag is provided, the framework is auto-detected from `package.json` dependencies.

### `vcc gen cron`

```
vcc gen cron <name>
```

Create a cron job file in `crons/` with `defineScheduled` and a placeholder cron expression.

```sh
vcc gen cron hourly-sync
```

### `vcc gen queue`

```
vcc gen queue <name>
```

Create a queue consumer file in `queues/` with `defineQueue`, a `Message` interface, and commented-out batch options.

```sh
vcc gen queue emails
```

## Secrets

### `vcc secret put`

```
vcc secret put <name> [--project <name>]
vcc secret put <name=value> [--project <name>]
```

Value input modes:

- inline: `vcc secret put API_KEY=abcd`
- prompt (TTY): `vcc secret put API_KEY` (masked input)
- stdin: `echo -n "abcd" | vcc secret put API_KEY`

### `vcc secret sync`

```
vcc secret sync <file> [--project <name>]
```

Bulk upload secrets from a dotenv file. Each `KEY=value` line in the file is uploaded as a secret.

```sh
vcc secret sync .env.local       # uploads secrets from .env.local
vcc secret sync .env.production  # uploads a specific file
```

### `vcc secret delete`

```
vcc secret delete <name> [--project <name>]
```

Project resolution for secrets follows the same order as deploy (`--project`, env var, linked project).

## Custom Domains

### `vcc domain add`

```
vcc domain add <hostname> [--project <name>]
```

Add a custom domain to a project. Prints the CNAME target you need to add in your DNS provider.

### `vcc domain remove`

```
vcc domain remove <hostname> [--project <name>]
```

Remove a custom domain from a project.

### `vcc domain list`

```
vcc domain list [--project <name>]
```

List all custom domains and their status (active/pending).

### `vcc domain status`

```
vcc domain status <hostname> [--project <name>]
```

Check verification and SSL status for a specific domain. Shows hostname, status, SSL status, and any verification errors.

Project resolution for domain commands follows the same order as deploy (`--project`, `VITE_CLOUD_PROJECT`, linked project).

## Agent

### `vcc init --agents`

Runs all agent setup steps:

1. **Instructions** — detects existing agent files (`.claude/`, `CLAUDE.md`, `AGENTS.md`) and injects Vite Cloud framework instructions with versioned markers
2. **Skills** — auto-detects coding agents (Claude Code, Cursor, Windsurf, Gemini CLI, GitHub Copilot, Codex, and [many more](https://github.com/vercel-labs/skills/blob/main/src/agents.ts)) and symlinks skills from the `vite-cloud` package into each agent's skills directory
3. **MCP config** — writes MCP server config to the appropriate project-level config file (e.g. `.claude/settings.json`, `.cursor/mcp.json`). For agents without project-level config, prints the CLI command to run instead

## Environment variables

| Variable             | Purpose                                                | Default |
| -------------------- | ------------------------------------------------------ | ------- |
| `VITE_CLOUD_TOKEN`   | Auth token override (instead of saved config)          | —       |
| `VITE_CLOUD_PROJECT` | Default project slug for deploy/secret/delete commands | —       |
