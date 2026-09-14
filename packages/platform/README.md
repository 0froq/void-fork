# @void/platform

Public, target-neutral contracts and packaged runtime artifacts for installing a Void company platform in a Cloudflare account.

The package contains:

- versioned deployment and installation manifests
- deterministic resource naming and application-route generation
- discovery-document and capability contracts
- Cloudflare Worker configuration generation for the core API, proxy, tail, and dispatch Workers
- A shared installation-owned traffic-disable protocol used by lifecycle-safe retained Workers
- integrity-checked, deployable Worker bundles and PostgreSQL migrations under the `./installer` export

The `void` CLI consumes this package for `void platform install`, `repair`, `upgrade`, `discover`, and `uninstall`. Platform implementation sources remain under `platform/packages/*`; their deployable core output is bundled here so a user installs one normal public `void` package rather than cloning or deploying the repository.

See the [self-hosted platform guide](../../docs/guide/self-hosted-platform.md) for the supported core feature set, Cloudflare footprint, and lifecycle commands.
