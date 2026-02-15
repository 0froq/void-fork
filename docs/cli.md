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

- `login`: GitHub OAuth login, saves token to `~/.vite-cloud/credentials.json`
- `logout`: removes saved credentials
- `whoami`: prints current GitHub login

## Project commands

```bash
vcd list
vcd link [name]
```

- `list`: list your projects (name, id, URL)
- `link [name]`: link current repo to an existing project by name (or prompt)

Linked project state is stored in `.vite-cloud/project.json`.

## Deploy

```bash
vcd deploy [--project <name>]
```

Behavior:

1. build app (`vite build`)
2. collect/validate migrations
3. package worker + assets + manifest
4. upload deployment

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
- prompt (TTY): `vcd secret put API_KEY`
- stdin: `echo -n "abcd" | vcd secret put API_KEY`

Project resolution for secrets follows the same order as deploy (`--project`, env var, linked project).

## Environment variables

- `VITE_CLOUD_TOKEN`: auth token override (instead of saved credentials)
- `VITE_CLOUD_PROJECT`: default project name override for deploy/secret commands
