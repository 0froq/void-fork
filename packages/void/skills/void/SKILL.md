---
name: void
description: Void skill for app development and CLI operations. Use this skill to route user requests to the appropriate bundled Void docs.
---

# Void Skill

This skill is a router. Open the minimum relevant docs files under `docs/` and execute.

Docs in this skill are bundled from `docs` during `void` package build and live at:

- `skills/void/docs/*.md`

## Command Naming

Use `void` in examples and commands in this skill.

- `void` and `void` are equivalent binaries. Prefer `void`.

## No-Args Behavior

If invoked without a concrete task, do a brief app status check and report:

1. App type (`fullstack`, `framework`, `spa`, `prebuilt`) using `docs/app-types.md` criteria.
2. Backend feature usage (`routes/`, `pages/`, `middleware/`, `migrations/`, `crons/`, `queues/`, SSR entries).
3. Runtime signals (`void/db`, `void/kv`, `void/storage`, queue usage).
4. Auth signals (`void/auth`, `auth` client imports, OAuth env vars).
5. Project linkage (`.void/project.json`) and config readiness (`void.json`, tsconfig extends).
6. Optional health checks (`void whoami`, `void db status` when relevant).

Then ask what to do next.

## Task Routing

| User intent                               | Docs file(s)                                                      |
| ----------------------------------------- | ----------------------------------------------------------------- |
| CLI command syntax, flags, env vars       | `docs/cli.md`                                                     |
| Initial setup, onboarding, first app      | `docs/quickstart.md`, `docs/cli.md`                               |
| App type detection and mode behavior      | `docs/app-types.md`, `docs/config.md`                             |
| Server/API routing and middleware         | `docs/server-routing.md`, `docs/hono.md`                          |
| Pages mode, loader/action, forms, layouts | `docs/pages-routing.md`, `docs/type-safety.md`                    |
| Database and migrations                   | `docs/db.md`, `docs/type-safety.md`                               |
| Typed fetch and end-to-end typing         | `docs/typed-fetch.md`, `docs/type-safety.md`                      |
| Authentication                            | `docs/auth.md`, `docs/env-vars.md`                                |
| Cloudflare runtime bindings and config    | `docs/cloudflare.md`, `docs/config.md`, `docs/env-vars.md`        |
| KV / storage / queues / cron jobs         | `docs/kv.md`, `docs/storage.md`, `docs/queues.md`, `docs/jobs.md` |
| SSR and caching                           | `docs/ssr.md`, `docs/cache.md`                                    |
| Deployment and CI                         | `docs/deployment.md`, `docs/cli.md`                               |
| MCP server usage                          | `docs/mcp.md`                                                     |
| API surface details                       | `docs/api.md`                                                     |

## Working Rules

- For CLI-heavy tasks, open `docs/cli.md` first.
- For multi-topic tasks, combine only the needed doc files.
- If docs and memory differ, follow docs.
