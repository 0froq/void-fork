# @void/platform

Runtime artifacts and contracts used by the Void CLI to install a team platform in a Cloudflare account.

Install the `void` package and follow [Install a Void Platform](https://void.cloud/guide/self-hosted-platform). Developers connect to the platform with `void connect <url>` and deploy through the same CLI.

## Documentation

- [Installation](https://void.cloud/guide/self-hosted-platform)
- [Administration](https://void.cloud/guide/platform-administration)
- [Maintenance and recovery](https://void.cloud/guide/platform/installation/maintenance)
- [Platform development](https://void.cloud/guide/platform-development)

## Runtime Artifacts

The package contains installation manifests, resource naming, discovery contracts, Worker configuration, and deployable bundles under the `./installer` export. Platform source lives in `platform/packages/`.

Runtime artifacts include migration SQL, its journal, and a rollback compatibility manifest. Drizzle authoring snapshots remain in the source tree. Migrations are forward-only; compatibility edges in `platform/packages/api/drizzle/compatibility.json` must be tested against the earlier runtime before publication. The build verifies schema lineage and hashes the journal and SQL files.

See [Schema and CI](https://void.cloud/guide/platform/development/schema-ci) for schema changes and [Runtime and Source Builds](https://void.cloud/guide/platform/development/runtime) for building a custom runtime.
