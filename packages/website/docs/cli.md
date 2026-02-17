---
outline: deep
---

# CLI

`vite-cloud` ships a CLI with two binaries:

- `vcd` (short)
- `vite-cloud` (alias)

Examples below use `vcd`.

## Setup

### `vcd init`

Interactive setup wizard for adding vite-cloud to an existing project. Walks through:

1. **TypeScript** — creates or updates `tsconfig.json` (adds `extends .vite-cloud/tsconfig.json` and `vite-cloud/env` types)
2. **Authentication** — configures auth providers (GitHub, Google, Email) in `vite-cloud.json`
3. **Demo code** — optionally scaffolds a migration, API route, and typed fetch example
4. **GitHub Actions** — optionally creates `.github/workflows/deploy.yml` with the correct package manager commands

## Auth

### `vcd login`

OAuth login (GitHub or Google — you choose at the prompt). Saves token to `~/.vite-cloud/credentials.json`.

### `vcd logout`

Removes saved credentials.

### `vcd whoami`

Prints your current login.

### `vcd token`

Copies your auth token to the system clipboard. Useful for setting up CI secrets.

## Project commands

### `vcd projects`

List all your projects (slug, mode, URL).

### `vcd link [name]`

Link current directory to an existing project by slug, or select interactively if omitted. State is stored in `.vite-cloud/project.json`.

### `vcd delete [name]`

Permanently delete a project and all its resources (databases, KV namespaces, R2 buckets, deployments). Requires typing the project slug to confirm.

If `[name]` is omitted, uses the linked project.

## Deployment history

### `vcd list [name]`

Show the last 5 deployments for a project. Alias: `vcd ls`.

- If `[name]` is provided, looks up the project by slug
- Otherwise uses the linked project from `.vite-cloud/project.json`

## Deploy

### `vcd deploy`

```
vcd deploy [--project <name>] [--dir <path>] [--spa]
```

Auto-detects your project type and chooses the right pipeline. See [App Types](./app-types.md) and [Deployment](./deployment.md) for details.

| Flag               | Purpose                                           |
| ------------------ | ------------------------------------------------- |
| `--project <name>` | Target a specific project by slug                 |
| `--dir <path>`     | Deploy a pre-built static directory (skips build) |
| `--spa`            | Use SPA mode instead of SSG for static deploys    |

Project resolution precedence:

1. `--project <name>`
2. `VITE_CLOUD_PROJECT`
3. linked project in `.vite-cloud/project.json`

If no project is linked and no override is provided, CLI prompts to link or create one.

## Database

### `vcd db status`

Show migration status. Displays which migrations are applied or pending locally. When logged in and linked to a project, also shows remote status.

### `vcd db reset`

Drop the local D1 database and re-apply all migrations. Does not affect the remote database.

### `vcd db seed`

```
vcd db seed [--file <path>]
```

Reset the local database, re-apply all migrations, then execute a seed file. Defaults to `migrations/seed.sql`. The seed file is excluded from migration collection — it's never deployed or applied as a migration.

## Secrets

### `vcd secret put`

```
vcd secret put <name> [--project <name>]
vcd secret put <name=value> [--project <name>]
```

Value input modes:

- inline: `vcd secret put API_KEY=abcd`
- prompt (TTY): `vcd secret put API_KEY` (masked input)
- stdin: `echo -n "abcd" | vcd secret put API_KEY`

### `vcd secret delete`

```
vcd secret delete <name> [--project <name>]
```

Project resolution for secrets follows the same order as deploy (`--project`, env var, linked project).

## Custom Domains

### `vcd domain add`

```
vcd domain add <hostname> [--project <name>]
```

Add a custom domain to a project. Prints the CNAME target you need to add in your DNS provider.

### `vcd domain remove`

```
vcd domain remove <hostname> [--project <name>]
```

Remove a custom domain from a project.

### `vcd domain list`

```
vcd domain list [--project <name>]
```

List all custom domains and their status (active/pending).

### `vcd domain status`

```
vcd domain status <hostname> [--project <name>]
```

Check verification and SSL status for a specific domain. Shows hostname, status, SSL status, and any verification errors.

Project resolution for domain commands follows the same order as deploy (`--project`, `VITE_CLOUD_PROJECT`, linked project).

## Environment variables

| Variable             | Purpose                                                | Default                  |
| -------------------- | ------------------------------------------------------ | ------------------------ |
| `VITE_CLOUD_TOKEN`   | Auth token override (instead of saved credentials)     | —                        |
| `VITE_CLOUD_PROJECT` | Default project slug for deploy/secret/delete commands | —                        |
| `VITE_CLOUD_API_URL` | Platform API endpoint                                  | `https://api.vite.cloud` |
