# @void/platform

Public, target-neutral contracts and packaged runtime artifacts for installing a Void company platform in a Cloudflare account.

The package contains:

- versioned deployment and installation manifests
- deterministic resource naming and application-route generation
- discovery-document and capability contracts
- Cloudflare Worker configuration generation for the core API, proxy, tail, and dispatch Workers
- A shared installation-owned traffic-disable protocol used by lifecycle-safe retained Workers
- integrity-checked, deployable Worker bundles plus a schema-versioned PostgreSQL migration and rollback-compatibility manifest under the `./installer` export

The `void` CLI consumes this package for `void platform install`, `repair`, `upgrade`, `discover`, and `uninstall`. Platform implementation sources remain under `platform/packages/*`; their deployable core output is bundled here so a user installs one normal public `void` package rather than cloning or deploying the repository.

Platform migrations are forward-only. `platform/packages/api/drizzle/compatibility.json` declares exact source-version/schema-digest edges whose old Workers are safe against the target schema. The runtime build validates that each source digest is a prefix of the same PostgreSQL lineage and hashes the journal and every SQL file. When adding a migration, use an expand-compatible change, add only edges verified against the old runtime, and keep destructive contract cleanup for a later release after rollback to the old Workers is no longer possible.

See the [self-hosted platform guide](../../docs/guide/self-hosted-platform.md) for the supported core feature set, Cloudflare footprint, and lifecycle commands.
