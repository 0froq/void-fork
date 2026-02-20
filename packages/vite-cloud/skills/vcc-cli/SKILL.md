---
name: vcc-cli
description: Use the Vite Cloud CLI (vcc) for deploying, managing databases, generating code, configuring secrets, custom domains, and project management. Use when users ask to "deploy", "generate a model", "run migrations", "add a secret", "set up a domain", or manage Vite Cloud infrastructure.
---

# Vite Cloud CLI (`vcc`)

`vcc` is the CLI for Vite Cloud. It is a local binary from the `vite-cloud` package — always invoke via `npx vcc`, `pnpm vcc`, or `bunx vcc`.

## Quick Start

```sh
npm install -D vite-cloud    # install locally
npx vcc login                # OAuth (GitHub or Google)
npx vcc init                 # setup wizard (tsconfig, agent instructions, demo code, CI)
npx vcc deploy               # build + deploy
```

## Prerequisites

Before running most commands, the project must be **linked**:

- `.vite-cloud/project.json` exists (created by `npx vcc link [slug]`)
- Or pass `--project <slug>` to override
- Or set `VITE_CLOUD_PROJECT` env var

For CI/CD, set `VITE_CLOUD_TOKEN` env var instead of interactive login.

## Decision Tree

Based on user intent, read the relevant reference file:

| Intent                              | Reference                       |
| ----------------------------------- | ------------------------------- |
| First-time setup, init, login       | `references/getting-started.md` |
| Deploy, CI/CD, deployment history   | `references/deployment.md`      |
| Database, migrations, SQL, seed     | `references/database.md`        |
| Generate code, scaffold model/route | `references/code-generation.md` |
| Secrets, environment variables      | `references/secrets.md`         |
| Custom domains, DNS                 | `references/domains.md`         |
| Projects, link, delete, whoami      | `references/projects.md`        |

Use `npx vcc <command> --help` for full flag details on any command.

## Anti-Patterns

- **Don't install globally** — `vite-cloud` must match the project's runtime version. Always use local `npx vcc`.
- **Don't deploy without linking** — `vcc deploy` needs a project target. Use `npx vcc link`, `--project`, or `VITE_CLOUD_PROJECT`.
- **Don't use interactive login in CI** — set `VITE_CLOUD_TOKEN` env var instead.
- **Don't modify `.vite-cloud/` generated files** — `routes.d.ts`, `db.d.ts`, `tsconfig.json`, and `project.json` are managed by the CLI and Vite plugin.
- **Don't confuse `db reset` with `db migrate`** — `reset` drops all data and re-applies from scratch; `migrate` preserves data and only applies pending migrations.
- **Don't forget `--project` in CI** — when deploying multiple projects from one repo, always specify the target.
