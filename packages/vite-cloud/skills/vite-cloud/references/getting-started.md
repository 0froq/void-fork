# Getting Started

## Install

```sh
npm install -D vite-cloud
```

Always install locally as a dev dependency — never globally.

## Login

```sh
npx vite-cloud login
```

Interactive OAuth flow (GitHub or Google). Saves token to `~/.vite-cloud/config.json`.

For CI, skip login and set `VITE_CLOUD_TOKEN` env var instead.

## Init

```sh
npx vite-cloud init
```

Setup wizard for new and existing projects.

If run in an empty directory, it scaffolds a starter app first.

Then it walks through:

1. **TypeScript** — creates or patches `tsconfig.json` to extend `.vite-cloud/tsconfig.json`
2. **Agent instructions + skills + MCP** — detects the agent once (or asks you to pick Claude/Cursor/Codex/Gemini CLI/Generic) and reuses that selection for all agent setup steps
3. **Demo code** — scaffolds a migration, API route, and typed fetch example
4. **GitHub Actions** — creates `.github/workflows/deploy.yml`

Run individual steps with flags (no prompts):

```sh
npx vite-cloud init --tsconfig    # only tsconfig
npx vite-cloud init --agents      # agent instructions + skills + MCP config
npx vite-cloud init --github      # only GitHub Actions workflow
```

Flags can be combined: `npx vite-cloud init --tsconfig --github`.

`--agents` runs all agent setup steps: injects instructions into the appropriate file (CLAUDE.md/AGENTS.md), links skills, and writes MCP server config from one shared agent detection/selection step.

## Link

```sh
npx vite-cloud link [slug]
```

Link the current directory to an existing project. If slug is omitted, prompts to select interactively. Writes `.vite-cloud/project.json`.

## Verify Auth

```sh
npx vite-cloud whoami    # prints current login
npx vite-cloud token     # copies auth token to clipboard (for CI secrets)
```
