---
title: Shared application analysis
status: implemented
created: 2026-10-02
---

# Shared application analysis

## Ownership

`packages/void/src/application-analysis.ts` resolves source paths, framework,
binding inference and overrides, auth, database requirements, migrations, and
handler inventories. It records the reasons for resource requirements.
`application-routing.ts` completes HTTP export and page analysis using those
inventories. The plugin, preparation/type generation, native resource planner,
and managed packaging consume this result instead of reconstructing enablement.

Each source phase has its own snapshot. Plugin construction inventories both
route environments for stable binding and class reservations. Vite's config
hook selects development or production analysis; route HMR refreshes it. Builds
and deploys select production; `void prepare` includes both environments.
Completing a snapshot reuses its route, middleware, cron, queue, WebSocket, and
email inventories. HTTP export detection creates separate route objects so it
does not mutate the original snapshot.

## Resource rules

Explicit binding overrides apply per field. Unspecified bindings retain source
inference. `false` disables the named inferred binding, while custom strings
enable it with the existing name mapping. An override of KV therefore cannot
suppress storage, auth, Live, Sandbox, or queues.

The database requirement includes source usage, auth and checked-in migrations.
SQLite selects D1; PostgreSQL/MySQL selects Hyperdrive. The same predicate is used
by plugin emission, native planning and both managed manifest builders. Source
`needsD1` remains distinct from this resolved requirement so diagnostics can
distinguish explicit overrides from dependency requirements.

Inbound email handlers remain independent of the outbound email switch. Queue
handler inventory remains independent of importing the queue producer API.
Configured Sandbox and inferred Sandbox are resolved together; apps without
Sandbox continue to emit no paid binding or perform an entitlement probe.

## Target responsibilities

Provider IDs, resource names, migration history, credentials and cutover are
still owned by the deployment target. Analysis does not rename or adopt any
persistent resources.

The existing `@void/deploy-core` artifact, manifest and asset-manifest versions
remain unchanged. Managed packaging emits that contract; native deployment
compiles Cloudflare Build Output and validates the actual emitted provider
configuration. A source snapshot does not replace artifact validation. Native
deployment still rereads migration bytes after the build, since project plugins
can change SQL before remote application. The platform independently validates
uploaded manifests and Worker bytes and receives no source paths or analysis.

## Verification

Focused regressions cover partial/custom/false overrides, sourceDir, framework
scan directories, auth and migration dependencies, environment filtering,
WebSocket name reservations and a resource-free app. Consumer regressions call
the production plugin configuration, native planner and both managed manifest
builders, including migration-only SQLite and PostgreSQL applications.

Repository verification includes affected builds/server/browser tests, all
playground builds and artifact checks, typechecking, lint and the full suite.

The complete gate passed 632 files: 11,785 tests passed and 25 were skipped.
The rebuilt CLI also built and deployed a Void Worker app to the existing e2e
platform with a partial binding override. Its public route returned HTTP 200
with the new body, and rollback restored the previous test deployment and body.
