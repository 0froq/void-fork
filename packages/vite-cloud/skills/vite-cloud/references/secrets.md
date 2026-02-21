# Secrets

Secrets are encrypted environment variables available to your deployed worker at runtime.

## Put

```sh
npx vite-cloud secret put <name> [--project <name>]
```

Three input modes:

```sh
npx vite-cloud secret put API_KEY=myvalue          # inline
npx vite-cloud secret put API_KEY                  # interactive prompt (masked input)
echo -n "myvalue" | npx vite-cloud secret put API_KEY  # stdin (for CI)
```

## Sync

```sh
npx vite-cloud secret sync <file> [--project <name>]
```

Bulk upload from a dotenv file. Each `KEY=value` line is uploaded as a secret.

```sh
npx vite-cloud secret sync .env.local
npx vite-cloud secret sync .env.production
```

Use this for initial setup instead of multiple `put` calls.

## Delete

```sh
npx vite-cloud secret delete <name> [--project <name>]
```

## Project Resolution

Same precedence as deploy: `--project` flag > `VITE_CLOUD_PROJECT` env var > linked project in `.vite-cloud/project.json`.

## Notes

- Secrets are set per-project, not per-deployment.
- After setting secrets, redeploy for the worker to pick them up.
- No `list` command — secret values are write-only for security.
