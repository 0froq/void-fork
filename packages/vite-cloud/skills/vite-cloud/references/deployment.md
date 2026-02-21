# Deployment

## Deploy

```sh
npx vite-cloud deploy [--project <name>] [--dir <path>] [--spa] [--skip-build]
```

Auto-detects project type (fullstack or static) and runs the appropriate pipeline: build → package → upload.

| Flag               | Purpose                                               |
| ------------------ | ----------------------------------------------------- |
| `--project <name>` | Target a specific project by slug                     |
| `--dir <path>`     | Deploy a pre-built static directory (skips build)     |
| `--spa`            | Use SPA mode for static deploys (client-side routing) |
| `--skip-build`     | Skip build step, use existing build output            |

### Project Resolution

Order of precedence:

1. `--project <name>` flag
2. `VITE_CLOUD_PROJECT` env var
3. Linked project in `.vite-cloud/project.json`

If none found, CLI prompts to link or create a project.

## Deployment History

```sh
npx vite-cloud list [name]    # last 5 deployments
npx vite-cloud ls [name]      # alias
```

If `[name]` is omitted, uses the linked project.

## CI/CD Pattern

```sh
# In CI environment:
export VITE_CLOUD_TOKEN="..."           # auth token (from `npx vite-cloud token`)
npx vite-cloud deploy --project my-app        # always specify project in CI
```

To scaffold a GitHub Actions workflow:

```sh
npx vite-cloud init --github
```

This creates `.github/workflows/deploy.yml` with the correct package manager commands for your project.
