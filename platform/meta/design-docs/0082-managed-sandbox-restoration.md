---
title: Managed Sandbox restoration
status: complete
created: 2026-09-24
---

# Managed Sandbox restoration

Restore managed Sandboxes on installed platforms. The user explicitly requested
restoration and chose automatic availability after upgrade, with Containers
access checked only when an application deploys a Sandbox.

## Design

Each Sandbox deployment receives a regular platform-owned Worker containing a
fixed controller and the pinned Cloudflare Sandbox SDK. Applications receive a
restricted service interface, never the controller's Durable Object namespace,
control-plane binding or lifecycle hooks. Custom container images and instance
sizes remain supported. Native Cloudflare deployments keep their existing SDK.

The controller reserves concurrency before starting a container, starts metering
only after confirmed startup, and releases only after confirmed shutdown. Durable
generation identities fence stale lifecycle calls. Platform-owned heartbeats
enforce suspension and runtime budgets; missing authority stops execution.

Retain the old drain as a migration for tenant-owned containers. New deployments
carry server-authored controller identity. Deployment, rollback, retention,
cancellation and project cleanup verify resource ownership and distinguish the
trusted controller protocol from legacy containers. Older runtimes must not undo
the controller protocol during rollback.

## Work and verification

- [x] Implement restricted SDK transport and trusted lifecycle controller.
- [x] Separate concurrency reservation from actual runtime accounting.
- [x] Provision, recover and clean up controllers; preserve custom images/sizes.
- [x] Package controller source and enable installed platforms after upgrade.
- [x] Preserve legacy drain and prevent unsafe rollback.
- [x] Verify targeted runtime, deployment, accounting and installer regressions.
- [x] Run `vp run check`, builds and the full `vp test run` suite once integrated.
- [x] After verification, update public Sandbox/config/platform guides and shipped
      CLI skill guidance for the resulting workflows.

Local workerd tests must exercise actual RPC transport, including callbacks,
streams, sessions and rejection of lifecycle access. Provider mocks verify
ownership and failure compensation. Live Containers verification requires an
available test installation and was not available for this change. Local
verification completed with `vp lint`, `vp run check`, `vp run build:all` and
the full `vp test run` suite (10,875 passed, 24 skipped).
