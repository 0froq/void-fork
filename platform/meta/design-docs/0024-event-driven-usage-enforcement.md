---
title: Event-Driven Usage Enforcement
status: implemented
---

# Event-driven usage enforcement

Dispatch emits request-usage events to a Cloudflare Queue outside the request
response path. The API consumes those events and routes them to per-user
UsageCounter Durable Objects. A per-user counter matches the account-level
limits even when one user owns several projects.

Enforcement updates the routing state read by dispatch, while Analytics
Engine remains available for usage reporting. Periodic work handles billing
rollover and reconciliation; it is not the primary per-request accounting
path. Signed event envelopes authenticate producers before counters accept
events. This avoids an all-users, all-projects analytics query on every
enforcement interval.

The current implementation is in the
[usage counter](../../packages/api/src/usage-counter.ts) and
[dispatch usage path](../../packages/dispatch/src/index.ts).
