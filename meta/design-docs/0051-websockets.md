---
title: WebSocket Support
status: draft
created: 2026-03-05
---

# WebSocket Support

## Summary

Add first-class WebSocket support to Void, built on top of Cloudflare Durable Objects via the `partyserver` library. Two API layers: a high-level `defineRoom` (room-based with broadcast/connections) and a low-level `defineWebSocket` (raw connection lifecycle). File-based routing via `.ws.ts` extension. Fully automatic DO provisioning at deploy. Thin client helper with auto-reconnect.

## Motivation

Real-time features (collaborative editing, chat, live dashboards, multiplayer) are increasingly expected. Today, Void has no WebSocket support — users would need to manually configure Durable Objects and handle upgrades. This design makes WebSockets a first-class primitive, consistent with Void's philosophy of zero-config infrastructure.

## Dependencies

- [`partyserver`](https://github.com/cloudflare/partykit/tree/main/packages/partyserver) (v0.3.x) — thin DX layer over CF Durable Objects. Handles hibernation, connection lifecycle, broadcasting. Only dependency: `nanoid`.
- [`partysocket`](https://github.com/cloudflare/partykit/tree/main/packages/partysocket) — client-side WebSocket with auto-reconnect and buffering. Wrapped by Void's client helper.

Void owns: file-based routing, API surface (`defineRoom`/`defineWebSocket`), DO class generation, deploy provisioning, binding injection, client helper. PartyServer owns: DO internals, hibernation, connection management.

## File Convention

```
routes/
  chat/[room].ws.ts       # WebSocket route (room or connection-based)
  notifications.ws.ts     # Single-instance WebSocket endpoint
  api/health.ts           # Regular HTTP route (unchanged)
```

- `.ws.ts` extension signals a WebSocket route
- Each `.ws.ts` file compiles to one DO class
- Dynamic route params (e.g. `[room]`) determine the DO instance ID
- Lives in `routes/` because WebSocket endpoints are URL-addressable

## API Layer 1: `defineRoom` (high-level)

For multi-client scenarios: chat, collaboration, multiplayer.

```ts
// routes/chat/[room].ws.ts
import { defineRoom } from "void/ws";

export default defineRoom({
  // Called when DO wakes (first connection or after hibernation)
  onStart(room) {
    // room.storage  — per-DO persistent KV (PartyServer/DO storage)
    // room.env      — full Void bindings (db, kv, storage, ai)
    // room.id       — instance ID (derived from route params)
  },

  onConnect(room, connection) {
    room.broadcast(`${connection.id} joined`);
  },

  onMessage(room, connection, message) {
    // room.broadcast(msg, [excludeIds])
    // room.getConnections(tag?)
    // room.getConnection(id)
    room.broadcast(message, [connection.id]);
  },

  onClose(room, connection) {
    room.broadcast(`${connection.id} left`);
  },

  // Optional: handle HTTP requests to the same route
  onRequest(room, request) {
    const count = [...room.getConnections()].length;
    return Response.json({ connections: count });
  },
});
```

### Room API

| Property/Method                 | Type                                        | Description                              |
| ------------------------------- | ------------------------------------------- | ---------------------------------------- |
| `room.id`                       | `string`                                    | Instance ID derived from route params    |
| `room.env`                      | `CloudEnv`                                  | Full Void bindings (db, kv, storage, ai) |
| `room.storage`                  | `DurableObjectStorage`                      | Per-DO persistent key-value store        |
| `room.broadcast(msg, exclude?)` | `(string \| ArrayBuffer, string[]) => void` | Send to all connections                  |
| `room.getConnections(tag?)`     | `(string?) => Iterable<Connection>`         | Iterate connections                      |
| `room.getConnection(id)`        | `(string) => Connection \| undefined`       | Get specific connection                  |

### Connection API

| Property/Method             | Type                              | Description                       |
| --------------------------- | --------------------------------- | --------------------------------- |
| `connection.id`             | `string`                          | Unique connection identifier      |
| `connection.send(msg)`      | `(string \| ArrayBuffer) => void` | Send to this client               |
| `connection.close()`        | `() => void`                      | Terminate connection              |
| `connection.state`          | `unknown`                         | Connection-scoped ephemeral state |
| `connection.setState(data)` | `(unknown) => void`               | Set connection state              |

## API Layer 2: `defineWebSocket` (low-level)

For per-user persistent connections: notifications, streaming, live data.

```ts
// routes/notifications.ws.ts
import { defineWebSocket } from "void/ws";

export default defineWebSocket({
  onConnect(ws) {
    // ws.send(), ws.close(), ws.id, ws.env
  },

  onMessage(ws, message) {
    const data = JSON.parse(message);
    const result = await ws.env.ai.run("@cf/meta/llama-3-8b", data);
    ws.send(JSON.stringify(result));
  },

  onClose(ws) {},
});
```

No room abstraction — just individual connection lifecycle. Under the hood, still compiles to a PartyServer `Server` subclass (one connection per DO instance, or all connections sharing one instance depending on route params).

## Client API

```ts
import { connect } from "void/ws"

const ws = connect("/chat/room-123")

ws.send("hello")
ws.on("message", (msg) => console.log(msg))
ws.on("open", () => { ... })
ws.on("close", () => { ... })

// Auto-reconnects by default
// Buffers messages sent while disconnected
// Resolves URL relative to the app's origin
```

Wraps `partysocket` with Void-aware URL resolution. Framework-specific helpers (Vue composable, React hook) are a follow-up.

## Compilation

The Void compiler (`framework/packages/void/src/router/compile.ts`):

1. Scans `routes/` for `.ws.ts` files alongside existing route scanning
2. Each `.ws.ts` file generates a DO class extending `partyserver.Server`
3. Class name derived from file path: `routes/chat/[room].ws.ts` -> `ChatRoomWs`
4. The compiled worker entry exports DO classes alongside `fetch`/`queue`/`scheduled`
5. The `fetch` handler detects WebSocket upgrades and routes to the correct DO via `getServerByName()`
6. Dynamic route params in the URL -> DO instance ID (e.g. `[room]` param value becomes the DO name)

## Deploy Pipeline

Changes to `packages/api`:

### Manifest Extension

```ts
interface DeployManifest {
  // ... existing fields
  bindings: {
    // ... existing
    websocket?: string[]; // DO class names, e.g. ["ChatRoomWs"]
  };
}
```

### Provisioning Flow

1. Compiler detects `.ws.ts` files, adds DO class names to `bindings.websocket`
2. API reads class names from manifest
3. API generates `durable_objects.bindings` entries in wrangler config
4. API appends DO migration tags automatically (monotonic counter per project)
5. Worker upload includes DO class exports

### Migration Tracking

DO migrations are append-only. Each project tracks its current migration tag counter (new column on `projects` table or separate table). When a deploy adds or removes a `.ws.ts` file, the counter increments and a new migration entry is appended:

```json
{
  "migrations": [
    { "tag": "ws-v1", "new_classes": ["ChatRoomWs"] },
    { "tag": "ws-v2", "new_classes": ["NotificationsWs"], "deleted_classes": ["OldWs"] }
  ]
}
```

## Dispatch Routing

The dispatch worker (`packages/dispatch`) passes WebSocket upgrade requests through to user workers — Workers for Platforms supports this natively. The DO routing happens inside the user worker's generated `fetch` handler.

No changes needed to dispatch beyond ensuring `Upgrade: websocket` headers are forwarded (they already are in the standard `fetch` passthrough).

## Responsibility Split

| Concern                                         | Owner                                    |
| ----------------------------------------------- | ---------------------------------------- |
| File-based routing -> DO class generation       | Void                                     |
| `defineRoom` / `defineWebSocket` API            | Void                                     |
| URL -> DO instance routing                      | Void (via partyserver `getServerByName`) |
| Binding injection (D1, KV, R2, AI) into room/ws | Void                                     |
| DO migration management at deploy               | Void                                     |
| Client helper with auto-reconnect               | Void (wrapping `partysocket`)            |
| WebSocket hibernation                           | PartyServer                              |
| Connection lifecycle management                 | PartyServer                              |
| Broadcast / getConnections                      | PartyServer                              |
| DO storage API                                  | PartyServer / CF Durable Objects         |

## Open Questions

- **Metering**: Should WebSocket messages be metered like HTTP requests? Or just connection upgrades? Impacts Analytics Engine schema in dispatch.
- **Limits**: Per-plan connection limits? Message rate limiting?
- **Auth**: Should `onBeforeConnect` (edge-level auth check) be exposed? Or rely on existing Void auth middleware?
- **Type safety**: Typed message schemas (e.g. `defineRoom<{ type: "chat", text: string }>`)? Nice to have but not required for v1.
- **Vue/React composables**: Follow-up work. `connect()` is framework-agnostic for v1.
