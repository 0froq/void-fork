---
title: Self-hosted Platform Repository Cleanup
status: in-progress
created: 2026-09-15
---

# Self-hosted Platform Repository Cleanup

The framework and platform now share this repository. Make the checked-in
documentation, contributor setup, and developer tooling useful to people who
fork the repository and operate their own Void platform.

## Scope

Remove obsolete private-repository plans, personal access arrangements, and
environment-specific inventories. Preserve useful design rationale as clearly
labelled historical records. Document the current architecture and the supported
source-build and self-hosted workflows using explanation, example, and behavior.

Keep the distinction between the self-hosted core and the optional services used
by Void Cloud explicit. Workspace `private: true` flags prevent npm publication;
they do not describe source availability. Intentional hosted endpoints, wire
identifiers, compatibility aliases, and resource ownership checks remain valid.
This sweep does not rewrite Git history, alter hosted account settings, or deploy.

## Reviewable Changes

- [ ] Remove the unused private package registry configuration.
- [ ] Make uncredentialed CI runnable in forks and isolate first-party deployment assumptions.
- [ ] Replace obsolete repository-split and roadmap material with current architecture and an archive index.
- [ ] Remove private operational details and update reusable developer scripts.
- [ ] Rewrite platform/package guidance and add a source-development guide for forks.
- [ ] Sweep remaining documentation, examples, agent guidance, and comments for obsolete private-platform assumptions.
- [ ] Verify links, builds, typechecking, relevant tests, and the final full suite.

Each logical cleanup is committed separately on `main`, with a capitalized
subject ending in a period. The user has authorized these commits.

## Verification

Use focused tests for script or workflow behavior changes during development.
Run `vp run check` after implementation batches. Investigate slow or hanging tests
as they occur. At the end, build the core/platform/docs, check formatting and
linting, and run `vp test run` for final verification. Review the remaining search
matches rather than changing valid uses of private npm packages, service-to-service
APIs, or hosted compatibility defaults.

Update the root and affected package READMEs, relevant public docs, and the
bundled skill/agent guidance where the new contributor workflow changes the
appropriate reference. No new dependencies are planned.
