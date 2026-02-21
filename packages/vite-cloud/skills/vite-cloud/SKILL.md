---
name: vite-cloud
description: Vite Cloud skill for app development and CLI operations. Use this skill to route user requests to the appropriate bundled Vite Cloud docs.
---

# Vite Cloud Skill

This skill is a router. Open the minimum relevant docs files under `docs/` and execute.

Docs in this skill are bundled from `packages/website/docs` during `vite-cloud` package build and live at:

- `skills/vite-cloud/docs/*.md`

## Command Naming

Use `vcc` in examples and commands in this skill.

- `vite-cloud` and `vcc` are equivalent binaries. Prefer `vcc`.

## No-Args Behavior

If invoked without a concrete task, do a brief app status check and report:

1. App type (`fullstack`, `framework`, `spa`, `ssg`) using `docs/app-types.md` criteria.
2. Backend feature usage (`routes/`, `pages/`, `middleware/`, `migrations/`, `crons/`, `queues/`, SSR entries).
3. Runtime signals (`vite-cloud/db`, `vite-cloud/kv`, `vite-cloud/storage`, queue usage).
4. Auth signals (`vite-cloud/auth`, `auth` client imports, OAuth env vars).
5. Project linkage (`.vite-cloud/project.json`) and config readiness (`vite-cloud.json`, tsconfig extends).
6. Optional health checks (`vite-cloud whoami`, `vite-cloud db status` when relevant).

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
| SSR and caching                           | `docs/ssr.md`, `docs/cache.md`, `docs/edge-caching.md`            |
| Deployment and CI                         | `docs/deployment.md`, `docs/cli.md`                               |
| MCP server usage                          | `docs/mcp.md`                                                     |
| API surface details                       | `docs/api.md`                                                     |

## Working Rules

- For CLI-heavy tasks, open `docs/cli.md` first.
- For multi-topic tasks, combine only the needed doc files.
- If docs and memory differ, follow docs.
