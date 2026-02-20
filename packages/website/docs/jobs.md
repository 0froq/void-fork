# Jobs

Vite Cloud supports cron-triggered jobs from a top-level `crons/` directory.

## Job files

Create files in `crons/**/*.ts` (`.mts`, `.js`, `.mjs` also supported).

Each job file must export:

- `export const cron = "<expression>"`
- a default handler (recommended: wrapped with `defineJob`)

Example:

```ts
// crons/hourly-heartbeat.ts
import { defineJob } from "vite-cloud";

export const cron = "0 * * * *";

export default defineJob(async (controller, env) => {
  await env.KV.put("jobs:last-heartbeat", controller.scheduledTime.toString());
});
```

## `defineJob`

`defineJob(fn)` is a typed identity helper for scheduled jobs.

Handler signature:

```ts
(controller: ScheduledController, env: CloudEnv["Bindings"], ctx: ExecutionContext) =>
  unknown | Promise<unknown>;
```

Notes:

- Jobs are matched by exact cron string.
- Job modules are lazy-loaded at runtime.
- Files or directories starting with `_` are ignored.
- Missing `cron` export causes an error during scan/build.

## Deployment behavior

On deploy, Vite Cloud includes all discovered job schedules in the deploy manifest and configures worker cron triggers automatically.
