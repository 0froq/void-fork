---
title: Repository P1 Reliability Fixes
status: in-progress
created: 2026-09-15
---

# Repository P1 Reliability Fixes

Fix the 21 validated audit findings on `main`, preserving unrelated work. The
implementation baseline is `f41bfffa1584df3193038c05bf21f399e059b99c`.
The user explicitly authorized one commit per issue and a final review by four
GPT-5.6 Sol/high agents, followed by fixes for any P1 findings in these commits.
Commit subjects start with a capital letter and end with a period.

## Work and commit boundaries

- [x] 1. Exclude authenticated/dynamic pages from the static cache.
- [x] 2. Respect response cache opt-outs and API eligibility in direct ISR.
- [x] 3. Move authoritative sandbox usage production out of tenant Workers.
- [x] 4. Separate GitHub installation visibility from installation authority.
- [x] 5. Enforce administrator suspension in browser auth and OAuth issuance.
- [x] 6. Bind environment developer tokens to the selected platform origin.
- [x] 7. Apply global authorization middleware to WebSocket upgrades.
- [x] 8. Preserve transactional remote D1 batches and resolve active Workers.
- [x] 9. Dispatch queue consumers by unambiguous names.
- [x] 10. Preserve live platform secrets during routine upgrades.
- [x] 11. Restore captured live traffic configuration after failed deployment.
- [x] 12. Allow invited account deletion while preserving invitation history.
- [x] 13. Store full OAuth tokens in generated MySQL auth schemas.
- [x] 14. Scope PostgreSQL/MySQL clients to the request using them.
- [x] 15. Share local D1 identity/persistence across dev and database tooling.
- [x] 16. Support Durable State methods through real Cloudflare RPC.
- [x] 17. Wire production Node/Bun/Deno Pages manifests and static assets.
- [x] 18. Support valid account/OAuth credentials in platform lifecycle reads.
- [x] 19. Verify certificate coverage for nested application domains before provisioning.
- [x] 20. Prevent canceled builds from launching untracked containers.
- [x] 21. Give sandbox concurrency leases globally unique instance identities.

Root owns token/lifecycle/traffic fixes (6, 10, 11, 18, 19) and integration.
Independent implementation agents own edge/proxy/sandbox (1, 2, 3, 8, 21),
control-plane/GitHub/builds (4, 5, 12, 20), and SDK/runtime (7, 9, 13–17).
Only root stages and commits, one completed issue at a time. Shared-file changes
must be coordinated before editing. No push, deployment, or live provisioning is
part of this task.

## Design constraints

Use shared policy and identity resolution rather than duplicate guards. Cache
reads and writes must enforce the same eligibility rules. Restore actual live
state during failure recovery. Tenant-controlled values must not become
authoritative account identity, usage totals, or cross-project lease identity.
Database schema changes must preserve supported upgrade/rollback compatibility.

For certificate coverage, preserve valid nested-domain installations, reject an
uncovered topology before provisioning, and provide explicit setup guidance.
Do not silently enable a paid certificate product. Prefer an application domain
at the zone apex for the simplest certificate setup.

Resolve routine implementation choices from existing contracts. Ask the user only
when a necessary developer-experience or compatibility decision cannot be
resolved from the task and current behavior.

## Verification and documentation

Recovery on 2026-09-16 matched the existing commits to 16 completed findings.
The pending local D1, Durable State, build cancellation, and usage changes were
preserved and completed; production Node/Bun/Deno asset integration was then
implemented. The original worktree diff and untracked files were backed up under
`/tmp` before resuming. All 21 original findings now have implementation commits;
final full verification and the requested four-agent review remain below.

Each fix includes a regression for the reported supported scenario and appropriate
failure/concurrency boundaries. Run only relevant `vp test run` selections during
implementation, and `vp run check` after a batch. Investigate slow/hanging tests
immediately. Builds and subprocess tests run sequentially when they share output.

After implementation, run package/platform builds, the full `vp test run` suite,
workspace typechecking, lint, formatting, and the docs build. Update affected
package READMEs/instructions, public guides/reference, and CLI/agent guidance
(`packages/void/skills/void`, `AGENT_PROMPT.md`, `getting-started-prompt.txt`) when
behavior or setup instructions change. Public prose follows the Fate-inspired
guide style already used in this repository. Preserve Workers Free compatibility
for native app deployment and avoid introducing dependencies without checking
their current npm versions.

- [ ] Final full verification passed.
- [x] Four GPT-5.6 Sol/high agents reviewed the complete commit range.
- [ ] Review P1 findings fixed individually and verified again.

## Review follow-ups

The first review pass covers `f41bfffa..23eec36d`. Builds, workspace checks,
lint, formatting, and the full suite passed (8,146 tests, 6 skipped). The review
identified the following remaining work:

- [x] Validate explicit deploy tokens through the shared origin guard while
      preserving GitHub OIDC precedence.
- [x] Do not report successful trigger recovery from an opaque handoff snapshot.
- [ ] Treat `Set-Cookie` responses as private in every hosted shared-cache path
      and exclude entries written under the older unsafe cache policy.
- [x] Fence interrupted transitions from unsigned to authenticated usage so
      old live dispatch cannot feed frames that the new consumer discards.
- [ ] Tie managed Sandbox admission, lifetime, and metering to a platform-owned
      controller. Tenant-owned acquire/release calls cannot establish authority,
      and lazy reservations must not be charged as running containers.

The Sandbox design decision is pending user input. The proposed complete cutover
uses a fixed platform-owned runtime Worker per Sandbox deployment, preserving
custom registry images and sizes. Tenant code receives only a restricted service
interface used by `getSandbox()`. Raw namespace access remains available for
native Cloudflare deployments; managed deployments cannot receive the raw
controller stub or lifecycle methods. This adds one regular Worker per managed
Sandbox deployment and requires owned-resource cleanup and legacy rollout guards.
