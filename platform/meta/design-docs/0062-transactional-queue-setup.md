---
title: Compensated Queue Setup During Deploy
status: implemented
created: 2026-04-19
---

# Compensated queue setup during deploy

Queue consumers and routing keys are external state: they cannot be committed
in the same PostgreSQL transaction as the active deployment. The deploy
pipeline therefore snapshots the relevant Cloudflare Queue consumer state
and routing KV values before it changes them. It writes through tracked
helpers under the project's cutover fence.

Consumer conflicts are collected and reported before any queue routing key
is changed. For a successful cutover, the new consumer configuration and
queue routing entries point to the deployment's Worker and proxy token.
Removed queues have their consumer and routing entry removed.

If the protected cutover fails, compensation restores the consumer
snapshots, tracked routing values, and cron state. A failed exact restore is
retried once. If compensation is still incomplete, the platform reconciles
external state to PostgreSQL's committed active deployment, or clears it
when the project has no active deployment. The cutover and compensation
claims are serialized with other project operations so a stale deploy
attempt cannot undo a newer one.

This is a fenced, compensating workflow rather than an atomic transaction
across Cloudflare Queues, KV, and PostgreSQL. The implementation lives in
[the deploy route](../../packages/api/src/routes/deploy.ts).
