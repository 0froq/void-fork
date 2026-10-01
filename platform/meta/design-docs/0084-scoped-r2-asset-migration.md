---
title: Scoped R2 asset migration
status: implemented
created: 2026-10-01
---

# Scoped R2 asset migration

## Storage contract

New deployments keep the platform asset mirror in R2 at
`assets/<project-id>/<content-hash>`. Preflight verifies this placement for static
and Worker deployments. A prior KV or unscoped R2 reference does not establish
that the scoped object exists. A missing scoped object requires an upload.
Cloudflare's Worker asset upload and the dispatch fallback mirror remain.

Persisted entries carry `store: 'r2', scope: 'project'` only after scoped
verification. Older `store: 'r2'` metadata alone cannot bypass scoped inventory.
The reserved `/.void-deploy/` cachebuster is provider metadata, not a mirrored
serving asset, and is excluded from migration.

## Migration

`void platform system asset-migrations` inventories active deployment pointers,
retained rollback targets, and stored Worker bundles. It includes active targets
regardless of their historical status. The paginated result reports metadata
requiring migration and invalid persisted or serving manifests; it does not
replace reading and verifying asset bodies.

`void platform deployment migrate-assets <id>` previews and applies bounded
pages of eight unique hashes and a 32 MiB body budget. A larger R2 object
is processed alone using streams. The CLI confirms
once, pins each page to its fresh preview, and accepts a successful page's cursor
for recovery. A cursor cannot skip entries without persisted migration proof.
It never automatically retries an ambiguous mutation.

Each asset is read from its actual serving placement, copied to scoped R2 with
a create-only write, and read back. Both source and destination must match
size and the existing provider hash: BLAKE3 of base64 bytes plus extension,
truncated to 32 hexadecimal characters. Incremental base64 hashing avoids a
whole-file encoded copy. Repeated paths with the same extension share one
verification; every distinct extension remains checked.

Copying happens outside a PostgreSQL transaction. Publication takes the project
row lock used by deployment and retention, rejects deployment/rollback/recovery
or deletion in progress, and compares fresh lineage and manifests to the preview.
It reconstructs all remaining historical routes before publishing the first
page, then updates durable placement and the serving manifest for the verified
page. A partial migration never publishes a manifest containing only that page.
Later pages preserve verified scoped placement even if KV returns an older
serving manifest. Retention protects stored Worker history until its bundle is
successfully removed, then releases its unreferenced scoped assets for collection.
Original KV and unscoped R2 objects are preserved. An interrupted DB/KV
acknowledgement can leave different placement metadata; a retry reconciles it
using the serving manifest and freshly verified scoped bytes. Content-hash or
size disagreement fails closed.

## Retirement boundary

Historical dispatch reads, rollback reconstruction, and legacy bindings remain
through the migration release. Their removal requires upgrading an installation,
finishing in-flight work, migrating every referenced asset from all inventory
pages, and verifying serving and retained rollback targets. Dispatch caches
serving manifests for up to 24 hours, so reader retirement must also account for
old cached placement after the last manifest change. Old runtime versions
and lagging KV manifests can still reference preserved originals during rollout.
Deleting shared original objects requires a separate global reference inventory;
this migration deliberately performs no source deletion.

## Verification

Integration tests exercise scoped and unscoped KV, unscoped R2, unknown historical
placement, corrupt bodies, interruption, replay, cursor bounds, concurrent
lineage changes, active failed targets, and an actual retained static rollback.
The real dispatch runtime serves the migrated bytes after migration and rollback
with legacy KV asset reads disabled. Retention tests cover stored failed history,
successful eviction, and failed bundle deletion.
New deployment tests prove old KV references cannot be carried into a new static
cutover and missing scoped bytes cannot publish routing. Hash tests preserve the
provider contract across empty bodies, chunk boundaries, padding, and extensions.
