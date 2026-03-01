# @voidcloud/tail

Tail worker for capturing user worker logs. Attached as a `tail_consumer` to the dispatch worker, it receives trace events from all user workers in the dispatch namespace.

## Architecture

- **`tail()` handler** — writes each trace event to Analytics Engine (`void_logs` dataset) and forwards to a `LogStream` Durable Object for live broadcasting.
- **`LogStream` DO** — per-worker-name Durable Object that accepts WebSocket connections and broadcasts trace events to connected clients. Uses WebSocket hibernation.
- **`fetch()` handler** — handles `GET /tail/:scriptName` WebSocket upgrade requests via service binding from the API worker.

## Analytics Engine Schema (`void_logs`)

| Slot         | Content                  |
| ------------ | ------------------------ |
| `indexes[0]` | scriptName               |
| `blobs[0]`   | outcome                  |
| `blobs[1]`   | JSON logs array          |
| `blobs[2]`   | JSON exceptions array    |
| `blobs[3]`   | Request URL              |
| `blobs[4]`   | Request method           |
| `blobs[5]`   | Response status (string) |
| `doubles[0]` | eventTimestamp (ms)      |
| `doubles[1]` | Response status (number) |

## Configuration

- Connected via `tail_consumers` in `packages/dispatch/wrangler.jsonc`
- API worker accesses via `TAIL` service binding
- No public routes — only reachable via tail events and service bindings

## Deploy

```bash
pnpm -F tail run deploy              # production
pnpm -F tail run deploy --env staging  # staging
```

Must be deployed **before** the dispatch worker (which references it as a tail consumer).
