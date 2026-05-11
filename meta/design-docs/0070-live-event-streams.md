---
title: Live Event Streams
status: draft
created: 2026-05-08
---

# Live Event Streams

## Summary

Add `void/live`: a Durable Object-backed event stream primitive for
production-safe cross-request fanout over Server-Sent Events.

`void/live` is not the low-level SSE helper. It composes with `void/sse`:

- `void/sse` formats frames and provides route-owned streaming helpers.
- `void/live` owns shared connection state and publish/broadcast semantics.

This solves the application shape where one request opens a long-lived stream
and later unrelated requests, scheduled handlers, or queue consumers publish
events into that stream.

## Motivation

Plain SSE is enough when the stream producer lives inside the same request that
opened the connection. It is not enough for cross-request fanout:

1. Client A opens `GET /events`.
2. Client B or a background task sends `POST /mutate`.
3. The mutation must publish into Client A's already-open stream.

In production, those requests may run in different Worker isolates. Module-level
event emitters are not reliable shared state. The correct coordination point is
a Durable Object scoped to the live stream.

`void/live` should make that pattern explicit, typed, and deployable without
users wiring Durable Object classes, bindings, migrations, stream formatting,
scope identity, or publish routing by hand.

## Goals

- Provide production-safe cross-request fanout over SSE.
- Keep connection endpoints as ordinary Void routes.
- Avoid `.sse.ts` and other transport-specific route conventions.
- Publish directly through generated Durable Object bindings, not through
  public self-fetch routes.
- Support singleton, per-user, per-document, per-room, and other scoped streams.
- Preserve event ordering within a stream scope.
- Provide typed event names and payloads via Standard Schema-compatible
  validators.
- Compose with `void/sse` for frame formatting and browser client ergonomics.
- Keep local dev behavior equivalent to production.

## Non-Goals

- Do not replace plain userland SSE for request-owned streams.
- Do not provide bidirectional messaging.
- Do not provide global multi-region pubsub in v1.
- Do not guarantee exactly-once delivery.
- Do not define database invalidation, entity subscription, query cache, or
  application-specific semantics.
- Do not support Node/Bun/Deno targets for native live fanout in v1.

## SSE And WebSocket Boundary

`void/live` is the native SSE fanout primitive. It should be chosen when the
browser only needs server-to-client events, native `EventSource` semantics are a
good fit, and the application wants ordinary HTTP routes plus cookie-based auth.

It is not a replacement for `void/ws`. Durable Objects can hibernate WebSocket
connections, but an open SSE response is an in-progress HTTP request. That means
SSE fanout is excellent for notifications, object updates, live status, and
moderate fanout, but users building bidirectional rooms, presence-heavy
collaboration, high-frequency state sync, or very large connection sets should
use `void/ws`.

Keeping this boundary explicit prevents `void/live` from growing into a
half-WebSocket abstraction. Future APIs can still compose with the same event
schemas, generated types, and scope identity, but `void/live` v1 remains the
best implementation of SSE fanout rather than a generic realtime framework.

## API

Live streams are declared separately from routes and then composed into normal
route handlers.

Recommended declaration convention:

```txt
live/
  notifications.ts
  document.ts
```

Example singleton stream:

```ts
// live/activity.ts
import { defineLiveStream } from 'void/live';
import * as v from 'valibot';

export const activity = defineLiveStream({
  events: {
    updated: v.object({
      id: v.string(),
      count: v.number(),
    }),
  },
});
```

Expose it from an ordinary route:

```ts
// routes/activity.ts
import { defineHandler } from 'void';
import { activity } from '../live/activity';

export const GET = defineHandler((c) => activity.connect(c));
```

`connect()` returns `Response | Promise<Response>`. Handlers can return it
directly. The promise form is important because `void/live` must be able to
validate scope and run `onConnect` before the `text/event-stream` response
starts.

Publish from any server-side code in the same app:

```ts
import { activity } from '../live/activity';

await activity.publish('updated', {
  id: 'item_123',
  count: 10,
});
```

`publish()` uses Void's server runtime environment context to resolve the
generated Durable Object binding. It is valid inside request handlers, scheduled
handlers, queue consumers, and other server-side code paths that Void runs with
an active runtime env. If code runs outside that context, it should use an
explicit environment form:

```ts
await activity.withEnv(env).publish('updated', payload);
```

This keeps common route code terse while making tests and non-request entry
points deterministic.

Scoped stream:

```ts
// live/document.ts
import { defineLiveStream } from 'void/live';
import * as v from 'valibot';

export const documentEvents = defineLiveStream({
  scope: v.object({
    documentId: v.string(),
  }),
  events: {
    changed: v.object({
      documentId: v.string(),
      version: v.number(),
    }),
  },
});
```

Connect:

```ts
// routes/documents/[documentId]/events.ts
import { defineHandler } from 'void';
import { documentEvents } from '../../../live/document';

export const GET = defineHandler((c) =>
  documentEvents.connect(c, {
    documentId: c.req.param('documentId'),
  }),
);
```

Publish:

```ts
await documentEvents.publish({ documentId }, 'changed', { documentId, version });
```

TypeScript should expose separate overloads for scoped and unscoped streams:

```ts
await activity.publish('updated', payload);
await documentEvents.publish({ documentId }, 'changed', payload);
```

## Composability

The design intentionally separates three layers:

1. Route ownership:
   Users decide which HTTP route opens a stream.
2. Transport:
   `void/sse` serializes SSE frames and provides `EventSource` helpers.
3. Fanout:
   `void/live` stores active connections and broadcasts events.

That keeps APIs composable:

- A route can authenticate, authorize, and derive scope before calling
  `stream.connect(c, scope)`.
- A mutation, scheduled handler, or queue consumer can import the same stream
  object and call `stream.publish(...)`.
- A client can use native `EventSource` or the `void/sse/client` wrapper.
- Higher-level libraries can build subscriptions or cache invalidation on top
  of `void/live` without reimplementing Durable Object fanout.

## Runtime Model

Each `defineLiveStream()` export compiles to a stream descriptor in a generated
registry. The app gets one generated `void/live` Durable Object class and one
Durable Object binding when at least one live stream exists.

Avoiding one Durable Object class per stream is intentional. Stream declarations
are product-level concepts and may grow with application features; Durable
Object classes and bindings are infrastructure-level resources with platform
limits, migration history, and rename/removal churn. A single generated class
keeps the public API flexible while letting each stream and scope map to its own
Durable Object instance.

Instance identity:

- unscoped stream: one Durable Object instance per stream id
- scoped stream: one Durable Object instance per stream id plus canonical scope
  key

The Durable Object owns:

- active SSE connections
- connection ids
- connection cleanup
- event serialization through `void/sse`
- payload validation
- event ordering within the instance
- heartbeats
- bounded per-connection queues
- optional replay
- slow consumer handling

The client-facing route returns a `ReadableStream` response with SSE headers.
The publisher path uses the generated `void/live` Durable Object binding
directly. It must not self-fetch the public connection route.

### Scope Identity

Scoped streams must define deterministic instance identity. The implementation
must not rely on raw `JSON.stringify(scope)` because object key insertion order
can split subscribers for the same logical object into different Durable Object
instances.

Default scope key derivation:

1. Validate scope through the configured Standard Schema validator.
2. Use the validated output, not the raw caller input.
3. Serialize primitives directly.
4. Serialize objects with keys sorted recursively.
5. Reject values that cannot be represented deterministically.

Users can override this for domain-specific identity:

```ts
export const documentEvents = defineLiveStream({
  scope: DocumentScope,
  scopeKey: (scope) => scope.documentId,
  events: {
    changed: ChangedEvent,
  },
});
```

The final Durable Object name should include both the stable stream id and the
canonical scope key. That prevents scope collisions between different streams
that use the same logical key.

### Environment Resolution

The generated live stream object should be a lightweight descriptor plus runtime
helpers. It must not store a concrete Durable Object namespace at module
initialization time.

At runtime:

- `connect(c, scope?)` resolves the binding from `c.env`.
- `publish(...)` resolves the binding from Void's active runtime env context.
- `withEnv(env)` returns a stream handle bound to that explicit env.

If no runtime env is available, `publish(...)` should throw a clear error:

```txt
void/live: publish() was called outside a Void server runtime context. Pass an
explicit env with stream.withEnv(env).publish(...).
```

This model allows the same stream declaration to be imported from route
handlers, scheduled handlers, queue consumers, tests, and other server-only code
without relying on global mutable binding state.

## Event Format

`void/live` uses standard SSE frames. When durable replay or durable counters are
enabled, frames include an `id`:

```txt
id: 42
event: changed
data: {"documentId":"doc_123","version":7}

```

Rules:

- event names come from the `events` map
- payloads are validated before publish
- payloads are JSON-serialized as SSE `data`
- when durable replay or durable counters are enabled, event ids are monotonic
  within a stream instance
- if event ids are emitted, the counter must be persisted in Durable Object
  storage so restart does not reset ids
- `Last-Event-ID` is reserved for replay support

The low-level frame formatting should use the same implementation as
`void/sse`.

## Connection Lifecycle

`connect()` returns a streaming `Response` after pre-stream validation has
completed. It may also return a normal non-streaming error response, such as
`401 Unauthorized`, `403 Forbidden`, or `400 Bad Request`, before any SSE bytes
are sent.

Connection setup order:

1. Resolve the generated Durable Object binding from `c.env`.
2. Validate and canonicalize scope.
3. Resolve connection context, including `ctx.user` when Void auth is available.
4. Run the optional `onConnect` hook.
5. If `onConnect` returns a `Response`, return that response without opening an
   SSE stream.
6. Create the SSE stream, register the connection, start heartbeats, and send an
   initial `: connected\n\n` comment.
7. Return the streaming `text/event-stream` response.

This ordering is required. Auth, authorization, malformed scope, and other
connection-level rejections must stay ordinary HTTP responses so clients do not
see a successful `EventSource` followed by an application-level error event.

The Durable Object should:

- validate scope
- run the optional connect hook
- send an initial `: connected\n\n` comment
- register the connection before returning the response
- remove the connection when the stream is cancelled
- close the writer when the request signal aborts
- send heartbeat comments every 15 to 30 seconds by default

Optional connect hook:

```ts
export const documentEvents = defineLiveStream({
  scope: v.object({ documentId: v.string() }),
  events: { changed: ChangedEvent },
  async onConnect(ctx) {
    if (!ctx.user) {
      return new Response('Unauthorized', { status: 401 });
    }
  },
});
```

Context:

```ts
ctx.request;
ctx.env;
ctx.user;
ctx.scope;
ctx.lastEventId;
ctx.storage;
ctx.connection.id;
ctx.connection.close();
ctx.connection.setState(value);
```

V1 should reuse Void's shared auth/session resolution for `ctx.user`. Routes can
still authenticate and authorize before calling `connect()`, which remains the
best option when authorization depends on route params or app-specific database
reads. The hook exists for stream-local connection policy and for APIs that want
the stream declaration to own its access rules.

## Backpressure

Each connection should have a bounded queue.

Suggested defaults:

- max queued events per connection: `100`
- max encoded event size: `64 KiB`
- slow consumer policy: close that connection

Publishing must not block indefinitely on one slow client. A stalled connection
must not prevent delivery to other subscribers in the same stream instance.

`publish()` semantics:

1. validate scope, event name, and payload
2. serialize the event frame once
3. enqueue the frame for each active connection in the stream instance
4. close connections whose queue is already full or whose writer has failed
5. resolve after the event has been accepted by the instance

`publish()` should not wait for every client socket to flush bytes over the
network. The guarantee is "accepted for fanout to currently connected,
non-overflowed consumers", not durable delivery.

## Replay

Live delivery is at-most-once by default.

The API should reserve replay now:

```ts
export const activity = defineLiveStream({
  replay: {
    limit: 100,
    ttlSeconds: 300,
  },
  events: {
    updated: UpdatedEvent,
  },
});
```

When replay is enabled:

- the Durable Object assigns monotonic event ids
- recent events are retained up to `limit` and `ttlSeconds`
- `Last-Event-ID` is honored on connect
- missed events are sent before the connection joins live fanout

Recommendation: ship v1 with live fanout, but without durable replay storage.
Keep the option shape reserved. If v1 does not persist a per-instance counter,
it should omit SSE `id` fields from `void/live` events. Emitting ids that can
reset after a Durable Object restart would make `Last-Event-ID` semantics harder
to add correctly later.

Until replay is implemented, `Last-Event-ID` should be ignored by `void/live`
except for exposing it on the connect context for user code. Docs must state
that reconnect recovery is not provided unless `replay` is enabled by an
implementation that actually stores recent events.

## Discovery And Code Generation

`void/live` needs reliable discovery because each stream requires generated
registry metadata and the app may require the shared live Durable Object class
and binding.

Recommended v1 convention:

- scan top-level `live/**/*.{ts,mts,js,mjs}`
- detect named exports initialized by `defineLiveStream(...)`
- derive stable stream ids from file path plus export name
- allow an optional `name` field for logs and diagnostics, not for identity

This is more reliable than scanning every source file and avoids a
transport-specific route suffix. Users still compose streams into any route they
want.

Generated artifacts:

- one shared Durable Object class export when live streams exist
- one shared Durable Object binding when live streams exist
- a generated registry that maps stream exports to binding metadata
- TypeScript types for scope, event names, and payloads

Deploy manifest:

```ts
live: {
  className: 'VoidLiveStreamDurableObject',
  bindingName: 'VOID_LIVE',
  streams: [
    {
      filePath: 'live/activity.ts',
      exportName: 'activity',
      streamId: 'live/activity.ts#activity',
      scoped: false,
    },
  ],
  classes: ['VoidLiveStreamDurableObject'],
  migrations: [...],
}
```

The platform API should provision these with the same Durable Object
upload/migration machinery used for other user-owned Durable Object classes, but
model them under `live`.

### Server-Only Boundary

Files under `live/` are server-only. They may import server runtime modules and
must not be included in client bundles.

Void should enforce this boundary:

- client builds should fail if a client module imports from `live/`
- generated client route types may reference live stream event types only when
  they can do so through type-only imports
- docs should recommend keeping browser helpers in separate client modules that
  use native `EventSource` or `void/sse/client`

This prevents `defineLiveStream` declarations and server-only dependencies from
leaking into frontend code.

### Naming And Collisions

Class and binding names should be stable across builds. The recommended
default class and binding names are:

```txt
className: VoidLiveStreamDurableObject
bindingName: VOID_LIVE
```

If those collide with user-provided bindings or classes, the compiler should
append a short deterministic hash. The manifest stores the final class and
binding names so deploy migration history remains stable.

Stream ids should also be stable across builds. The default derivation is:

```txt
<relative file path>#<export name>
```

If the encoded id exceeds practical limits, the compiler may append or replace
part of it with a short deterministic hash. Renaming a stream file or export
creates a new stream id, but does not require creating or deleting a Durable
Object class.

### Typed Client Surface

Files under `live/` are server-only, but the event map still needs to be usable
from browser code without importing server modules. Void should expose a real
package stub at `void/live/types`, and project codegen should override it the
same way `void/routes` is overridden today.

Generated files and paths:

- `void/live/types` is a package export whose default stub contains empty
  interfaces.
- Codegen writes `.void/live-types.d.ts`.
- `.void/tsconfig.json` maps `void/live/types` to `./live-types.d.ts`.
- The generated declaration augments `void/live/types` with project-specific
  stream ids, event maps, and scope types.

Generated module shape:

```ts
declare module 'void/live/types' {
  export interface LiveStreamEvents {
    'live/activity.ts#activity': {
      updated: {
        id: string;
        count: number;
      };
    };
  }

  export interface LiveStreamScopes {
    'live/activity.ts#activity': undefined;
    'live/document.ts#documentEvents': {
      documentId: string;
    };
  }
}
```

Browser code imports only erased types plus the client helper:

```ts
import { connectEventStream } from 'void/sse/client';
import type { LiveStreamEvents } from 'void/live/types';

type ActivityEvents = LiveStreamEvents['live/activity.ts#activity'];

const stream = connectEventStream<ActivityEvents>('/activity');

stream.on('updated', (event) => {
  event.data.count;
});
```

The boundary is important: browser code imports only erased types plus
`void/sse/client`, never the `live/` declaration module itself. Runtime code that
imports `void/live/types` should receive a tiny no-op module so type-only import
mistakes do not drag server declarations into client bundles.

## Local Dev

Local dev must use the same Durable Object-backed path as production.

Requirements:

- `stream.connect(c)` opens a stream through the generated binding.
- `stream.publish(...)` publishes through the same generated binding.
- tests should not rely on module-level shared state.

This parity is important because in-memory fanout can appear to work locally and
fail after deploy.

## Hosted Dispatch Behavior

`void/live` still returns an HTTP SSE response to the browser, so it depends on
the hosted streaming behavior specified in the `void/sse` RFC:

- no body reads
- no cache writes
- no ISR writes
- no asset fallback body probing
- per-response `text/event-stream` classification

This belongs in dispatch regardless of whether an app uses `void/sse` directly
or `void/live`.

## Documentation

Add docs covering:

- when to use plain `void/sse`
- when to use `void/live`
- singleton streams
- scoped streams
- auth before `connect()`
- publishing from routes, scheduled handlers, and queue consumers
- delivery semantics and replay limitations
- production constraints around slow consumers and connection lifetime
- when to use `void/ws` instead of `void/live`

## Testing

Runtime tests:

- `connect()` returns a valid `text/event-stream` response.
- scope validation and `onConnect` rejection return ordinary HTTP error
  responses before the SSE stream opens.
- `publish()` broadcasts to all active connections in the same scope.
- scoped streams isolate events by scope.
- disconnect removes the connection.
- slow consumers are closed without blocking other connections.
- `publish()` resolves after enqueue, not after every client flushes.
- `publish()` outside runtime env throws a clear error.
- `withEnv(env).publish(...)` works in tests and non-request entry points.
- payload validation rejects invalid events.
- event ids are omitted when no durable counter is implemented, or monotonic
  within a stream instance when ids are enabled.
- optional replay honors `Last-Event-ID` if implemented in v1.

Compiler/deploy tests:

- `live/` declarations generate stream registry metadata.
- apps with live streams generate one shared Durable Object class and binding.
- class and binding names are stable.
- stream ids and canonical scope keys are stable.
- naming collisions are resolved deterministically.
- client bundles cannot import server-only `live/` modules.
- `void/live/types` has a package stub and `.void/tsconfig.json` maps it to the
  generated `.void/live-types.d.ts` file.
- browser code can import generated type-only live event descriptors from
  `void/live/types`.
- live manifest validation rejects malformed entries.
- migration history is preserved across deploys.
- removing a live stream does not require deleting a Durable Object class.

End-to-end test:

- `GET /events` opens `stream.connect(c)`.
- `POST /publish` calls `stream.publish(...)`.
- two clients connected to the same scope both receive the published event.
- a client connected to a different scope does not receive it.

## Implementation Plan

1. Implement and test `void/sse`.
2. Harden hosted dispatch passthrough for `text/event-stream`.
3. Add `void/live` runtime types and server implementation.
4. Add `live/` scanning, generated registry metadata, generated
   `void/live/types` augmentation, and the shared Durable Object export.
5. Add package exports, platform manifest validation, DO bindings, and
   migration enrichment.
6. Add local dev parity.
7. Add docs and end-to-end examples.

## Open Questions

1. Should durable replay ship in v1, or should v1 reserve the API shape and only
   provide live fanout?
2. Should the top-level declaration folder be `live/`, `server/live/`, or
   configurable?
3. Should live streams support publishing from platform-owned workers, or only
   from code running inside the user's deployed app?
