# Projects

## List Projects

```sh
npx vite-cloud projects
```

Lists all your projects with slug, mode, and URL.

## Link

```sh
npx vite-cloud link [slug]
```

Link the current directory to an existing project by slug. If omitted, prompts to select interactively. Writes `.vite-cloud/project.json`.

This file is project-local state and should typically be in `.gitignore`.

## Delete

```sh
npx vite-cloud delete [name]
```

**Permanent.** Deletes a project and all its resources (databases, KV namespaces, R2 buckets, deployments). Requires typing the project slug to confirm.

If `[name]` is omitted, uses the linked project.

## Deployment History

```sh
npx vite-cloud list [name]    # last 5 deployments
npx vite-cloud ls [name]      # alias
```

## Auth

```sh
npx vite-cloud whoami         # print current login
npx vite-cloud login          # OAuth login (GitHub or Google)
npx vite-cloud logout         # remove saved credentials
npx vite-cloud token          # copy auth token to clipboard
```

Token is saved in `~/.vite-cloud/config.json`.
