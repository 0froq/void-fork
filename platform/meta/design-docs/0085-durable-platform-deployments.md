---
title: Durable platform deployments
status: implemented
created: 2026-10-01
---

# Durable platform deployments

## Contract

The API admits a validated deployment under the existing project lock and stores
an operation receipt in PostgreSQL. Worker modules are staged in private R2
objects, checked by SHA-256 before execution, and removed after settlement.
Admission and its Queue outbox are one transaction. A missing Queue send or lost
acknowledgement is recovered by the two-minute scheduled outbox.

The CLI sends one idempotency key for its submission retries. The key is bound to
the actor, project, build and input digest. Replaying the same admitted input
returns the existing receipt; changing input with the same key is rejected.
The receipt names the operation, which survives static no-op placeholder deletion.
The final result can name an already-live deployment for a verified no-op.

The POST keeps its NDJSON progress interface and adds an operation receipt header.
The CLI follows that exact operation after a broken or stalled stream. Progress
is sequenced, bounded and authorized against current project access. A page is
terminal only after it contains the persisted terminal result. Observation does
not own execution; stopping observation does not cancel deployment.

## Execution and recovery

An API Queue consumer claims an admitted operation once and executes the existing
deployment pipeline against its original placeholder and active-deployment
snapshot. It rechecks the actor, project, bound build and project deploy credential.
It preserves the existing cancellation, publication, project access, retention,
cutover and compensation fences. It does not perform fresh admission or allocate
a replacement deployment on redelivery.

[Queue consumers have a fifteen-minute wall-clock limit](https://developers.cloudflare.com/queues/platform/limits/).
An eighteen-minute lease, measured by PostgreSQL's clock, prevents takeover while
the original invocation can still run. The executor buffers terminal events until
the pipeline has finished and authoritative settlement is known. An unresolved
cutover remains pending even if the pipeline encountered an error.

Expired execution is reconciled rather than replayed. A committed deployment
returns success. An abandoned protected cutover restores the committed active
deployment through the existing recovery protocol. A failed candidate's private
Worker and serving artifacts must be confirmed removed before its recovery fence
is released. Application SQL and project-scoped resources are preserved. Unknown
cleanup outcomes remain pending and retry reconciliation; they do not authorize
another pipeline run. This deliberately avoids repeating SQL after a lost response.

## Installation boundary

The optional `deploymentExecution: 1` runtime contract installs the deployment
Queue, producer and fast scheduled outbox. Protocol-zero runtimes retain their
previous Worker configuration. The journal migration is additive.

New admission takes a shared lock on the installation lifecycle checkpoint in the
same transaction as its operation insert. A maintenance checkpoint closes admission;
admitted Queue work continues draining. Downgrading to a runtime without this
executor requires an authenticated drain proof after admission closes and before
changing Queue consumers or resources. Missing proof or pending operations blocks
the downgrade. This prevents retiring the executor while it owns work.

## Work units and verification

1. Receipt-aware CLI submission and reconnectable observation, with legacy-platform compatibility.
2. Platform journal, admission, Queue execution, conservative recovery and installation lifecycle wiring.
3. E2E installation rollout and real static/Worker deployment, disconnect, retry and rollback verification.

Focused tests cover replay/conflict, duplicate delivery, SQL-clock leases, exact
placeholder execution, no-op receipt survival, authorization, Worker bytes, corrupt
input, bounded cursor pages, cancellation, send loss, protected recovery, cleanup
retry, committed SQL preservation and downgrade fences. Final verification includes
package checks and the full repository gate. Live results are recorded after testing.

### Verification completed

The full repository gate passed: 630 test files, 11,761 passing tests and 25 skipped
tests, including formatting, lint, builds and workspace typechecking.

The existing workers.dev E2E installation was upgraded through the supported
installer. Its API, proxy, dispatch and PostgreSQL health checks passed. Provider
read-back confirmed the deployment Queue consumer and two-minute outbox schedule;
the authenticated execution probe reported protocol one and no pending operations.

Live tests passed for a normal CLI static deploy, disconnect immediately after
admission, identical submission replay, conflicting input rejection, static no-op
receipt survival, and the production client's reconnect after a deliberately broken
response stream. A Worker deployment loaded its staged module bytes and completed
after its observer disconnected. Cancellation preserved the previous live Worker.
HTTP checks verified new static and Worker content, retained static rollback, Worker
update and retained Worker rollback. The pre-existing application's active deployment
and HTTP response bytes remained identical.

Hard invocation expiry, lost acknowledgements, interrupted cutover, compensation,
authorization changes and deletion races are exercised by automated integration
tests. The live tests did not forcibly expire a Queue invocation. Recovery waits
until the eighteen-minute lease expires and reconciles or fails the candidate;
it never automatically reruns application SQL.

The two synthetic E2E app hostnames received explicitly approved Access bypass
applications for HTTP verification. Test projects and those applications remain
available for reuse. Void Cloud production was not deployed.
