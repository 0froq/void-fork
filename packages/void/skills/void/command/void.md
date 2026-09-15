# `/void` Command Flow

1. Open `SKILL.md`.
2. If no task/arguments are provided, run the brief app status check from `SKILL.md`.
3. If a task is provided, route to the smallest relevant set of `docs/*.md` files.
4. For CLI syntax and flags, always use `docs/cli.md`.
5. Execute, verify, and report concise next actions.

Local D1 commands use development’s configured binding ID (preview ID first) and persistence directory. After setting or changing `voidPlugin({ persistTo })`, run `void dev` to refresh the recorded path before using `void db`.

For Node.js, Bun, and Deno Pages apps, deploy both `dist/ssr` and `dist/client`. Start `dist/ssr/index.js` with the selected runtime; production manifest and asset lookup is relative to the emitted server module.
