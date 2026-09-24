---
title: Deployment Status Streaming
status: implemented
---

# Deployment status streaming

The platform emits structured deployment events as work progresses through
provisioning, build verification, migration, upload, and cutover. The CLI
consumes the stream to show the current step and deployment ID while the
operation is still running. Terminal events carry the outcome; stream
interruption is reported separately from a confirmed deployment failure.

This keeps the deployment record authoritative while giving users progress
without repeatedly polling a large status response. The implementation
spans [the deploy route](../../packages/api/src/routes/deploy.ts) and
[the CLI deploy client](../../../packages/void/src/cli/deploy.ts).
