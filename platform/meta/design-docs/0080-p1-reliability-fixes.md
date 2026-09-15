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

- [ ] 1. Exclude authenticated/dynamic pages from the static cache.
- [ ] 2. Respect response cache opt-outs and API eligibility in direct ISR.
- [ ] 3. Move authoritative sandbox usage production out of tenant Workers.
- [ ] 4. Separate GitHub installation visibility from installation authority.
- [ ] 5. Enforce administrator suspension in browser auth and OAuth issuance.
- [ ] 6. Bind environment developer tokens to the selected platform origin.
- [ ] 7. Apply global authorization middleware to WebSocket upgrades.
- [ ] 8. Preserve transactional remote D1 batches and resolve active Workers.
- [ ] 9. Dispatch queue consumers by unambiguous names.
- [ ] 10. Preserve live platform secrets during routine upgrades.
- [ ] 11. Restore captured live traffic configuration after failed deployment.
- [ ] 12. Allow invited account deletion while preserving invitation history.
- [ ] 13. Store full OAuth tokens in generated MySQL auth schemas.
- [ ] 14. Scope PostgreSQL/MySQL clients to the request using them.
- [ ] 15. Share local D1 identity/persistence across dev and database tooling.
- [ ] 16. Support Durable State methods through real Cloudflare RPC.
- [ ] 17. Wire production Node/Bun/Deno Pages manifests and static assets.
- [ ] 18. Support valid account/OAuth credentials in platform lifecycle reads.
- [ ] 19. Verify certificate coverage for nested application domains before provisioning.
- [ ] 20. Prevent canceled builds from launching untracked containers.
- [ ] 21. Give sandbox concurrency leases globally unique instance identities.

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
- [ ] Four GPT-5.6 Sol/high agents reviewed the complete commit range.
- [ ] Review P1 findings fixed individually and verified again.
