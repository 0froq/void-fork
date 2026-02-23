# Queues Playground

API-only app demonstrating Cloudflare Queues integration with typed producers, consumers, and KV bridging.

## Structure

```
routes/api/
  send.ts          # POST — produces a message to the queue
  result.ts        # GET — reads processed results from KV
queues/
  test-queue.ts    # Queue consumer — batch-processes messages into KV
```

## Features

- **Queue producer** — `POST /api/send` uses `queues["test-queue"].send({ key, value })` from `void/queues`
- **Queue consumer** — `defineQueue<{ key, value }>()` for typed batch message handling with `maxBatchTimeout = 1` for immediate delivery
- **KV bridge** — consumer writes `queue-result:<key>` entries to KV; `GET /api/result?key=...` reads them back
- **End-to-end flow** — send → consumer → KV round-trip, integration-tested
