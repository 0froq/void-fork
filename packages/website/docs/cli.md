# CLI

`vite-cloud` ships a CLI with two binaries:

- `vcd` (short)
- `vite-cloud` (alias)

Examples below use `vcd`.

## Auth

```bash
vcd login
vcd logout
vcd whoami
```

- `login`: OAuth login (GitHub or Google — you choose at the prompt), saves token to `~/.vite-cloud/credentials.json`
- `logout`: removes saved credentials
- `whoami`: prints your current login

## Project commands

```bash
vcd list
vcd link [name]
vcd delete [name]
```

- `list` (alias `ls`): list your projects (slug, id, URL)
- `link [name]`: link current directory to an existing project by slug, or select interactively if omitted
- `delete [name]`: permanently delete a project and all its resources (databases, KV namespaces, R2 buckets, deployments). Requires typing the project slug to confirm.

Linked project state is stored in `.vite-cloud/project.json`.

## Deploy

```bash
vcd deploy [--project <name>]
```

Pipeline:

1. Build app (`vite build`)
2. Detect framework mode (TanStack Start, React Router) or default Hono routing
3. Infer Cloudflare bindings from source (D1, KV, R2)
4. Collect and validate migrations from `migrations/*.sql`
5. Scan for scheduled jobs (cron triggers)
6. Detect SSR entry (`src/main.ssr.ts`)
7. Package worker + assets + manifest into a single upload
8. Deploy to platform

Project resolution precedence:

1. `--project <name>`
2. `VITE_CLOUD_PROJECT`
3. linked project in `.vite-cloud/project.json`

If no project is linked and no override is provided, CLI prompts to link or create one.

## Secrets

```bash
vcd secret put <name> [--project <name>]
vcd secret put <name=value> [--project <name>]
vcd secret delete <name> [--project <name>]
```

`secret put` value input modes:

- inline: `vcd secret put API_KEY=abcd`
- prompt (TTY): `vcd secret put API_KEY` (masked input)
- stdin: `echo -n "abcd" | vcd secret put API_KEY`

Project resolution for secrets follows the same order as deploy (`--project`, env var, linked project).

## Environment variables

| Variable             | Purpose                                                | Default                  |
| -------------------- | ------------------------------------------------------ | ------------------------ |
| `VITE_CLOUD_TOKEN`   | Auth token override (instead of saved credentials)     | —                        |
| `VITE_CLOUD_PROJECT` | Default project slug for deploy/secret/delete commands | —                        |
| `VITE_CLOUD_API_URL` | Platform API endpoint                                  | `https://api.vite.cloud` |
