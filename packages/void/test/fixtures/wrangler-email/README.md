# wrangler email prose fixtures

Historical stdout / stderr / exit code of Wrangler's `email` command group and
`whoami --json`, captured read-only against a real account. The `cf` command
adapter emits compatible prose for the existing parsers, and parser tests use
these fixtures. The directory name records the original capture version.

Capture (all read-only; `WRANGLER_SEND_METRICS=false`, account pinned via
`CLOUDFLARE_ACCOUNT_ID`):

```
node <wrangler-dist/cli.js> whoami --json
node <wrangler-dist/cli.js> email routing settings <zone>
node <wrangler-dist/cli.js> email routing rules list <zone>
node <wrangler-dist/cli.js> email sending settings <domain>
node <wrangler-dist/cli.js> email routing settings <not-a-zone>       # exit 1
node <wrangler-dist/cli.js> email sending settings <not-onboarded>    # exit 1
```

Personal identifiers in `whoami.stdout` (email, personal account ids/names) and the
`~/.wrangler/logs/...` path in the stderr captures are replaced with placeholders;
every other byte is as printed. Every `wrangler email` run prints an "open beta
command" warning on stderr — the parsers read stdout only.
