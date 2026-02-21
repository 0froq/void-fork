# Custom Domains

## Add

```sh
npx vite-cloud domain add <hostname> [--project <name>]
```

Prints the **CNAME target** you need to configure in your DNS provider. The domain won't be active until DNS propagates and verification succeeds.

## Remove

```sh
npx vite-cloud domain remove <hostname> [--project <name>]
```

## List

```sh
npx vite-cloud domain list [--project <name>]
```

Shows all custom domains and their status (active/pending).

## Status

```sh
npx vite-cloud domain status <hostname> [--project <name>]
```

Check verification and SSL status for a specific domain. Shows hostname, status, SSL status, and any verification errors.

## Typical Workflow

1. `npx vite-cloud domain add example.com` — get the CNAME target
2. Add a CNAME record in your DNS provider pointing to the target
3. Wait for DNS propagation (can take minutes to hours)
4. `npx vite-cloud domain status example.com` — verify it's active

## Project Resolution

Same precedence as deploy: `--project` flag > `VITE_CLOUD_PROJECT` env var > linked project.
