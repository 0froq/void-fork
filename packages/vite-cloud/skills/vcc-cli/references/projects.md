# Projects

## List Projects

```sh
npx vcc projects
```

Lists all your projects with slug, mode, and URL.

## Link

```sh
npx vcc link [slug]
```

Link the current directory to an existing project by slug. If omitted, prompts to select interactively. Writes `.vite-cloud/project.json`.

This file is project-local state and should typically be in `.gitignore`.

## Delete

```sh
npx vcc delete [name]
```

**Permanent.** Deletes a project and all its resources (databases, KV namespaces, R2 buckets, deployments). Requires typing the project slug to confirm.

If `[name]` is omitted, uses the linked project.

## Deployment History

```sh
npx vcc list [name]    # last 5 deployments
npx vcc ls [name]      # alias
```

## Auth

```sh
npx vcc whoami         # print current login
npx vcc login          # OAuth login (GitHub or Google)
npx vcc logout         # remove saved credentials
npx vcc token          # copy auth token to clipboard
```

Token is saved in `~/.vite-cloud/config.json`.
