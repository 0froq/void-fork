# Getting Started

## Install

```sh
npm install -D vite-cloud
```

Always install locally as a dev dependency — never globally.

## Login

```sh
npx vcc login
```

Interactive OAuth flow (GitHub or Google). Saves token to `~/.vite-cloud/config.json`.

For CI, skip login and set `VITE_CLOUD_TOKEN` env var instead.

## Init

```sh
npx vcc init
```

Interactive setup wizard. Walks through four steps:

1. **TypeScript** — creates or patches `tsconfig.json` to extend `.vite-cloud/tsconfig.json`
2. **Agent instructions** — adds Vite Cloud instructions to `CLAUDE.md` or `AGENTS.md`
3. **Demo code** — scaffolds a migration, API route, and typed fetch example
4. **GitHub Actions** — creates `.github/workflows/deploy.yml`

Run individual steps with flags (no prompts):

```sh
npx vcc init --tsconfig    # only tsconfig
npx vcc init --agent       # only agent instructions
npx vcc init --github      # only GitHub Actions workflow
```

Flags can be combined: `npx vcc init --tsconfig --github`.

`--agent` auto-detects the agent environment (Claude Code, Cursor, Codex) and creates the appropriate file.

## Link

```sh
npx vcc link [slug]
```

Link the current directory to an existing project. If slug is omitted, prompts to select interactively. Writes `.vite-cloud/project.json`.

## Verify Auth

```sh
npx vcc whoami    # prints current login
npx vcc token     # copies auth token to clipboard (for CI secrets)
```
