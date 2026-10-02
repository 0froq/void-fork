---
outline: deep
---

# Live Event Streams

`void/live` lets a browser subscribe to several topics over one SSE connection. Publish an event from a route, scheduled job, or queue consumer, and Void delivers it to connected subscribers using Durable Objects.

For example, a page can subscribe to updates for a post and its comments, then change those subscriptions as the user navigates. If a single request produces the whole stream, such as an AI response, [`void/sse`](./sse.md) is enough.

## Define A Stream

Define a stream in a server-only module:

```ts
// src/live.ts
import { defineLiveStream } from 'void/live';

export const live = defineLiveStream({
  id: 'app',
  allowAnonymousControl: true,
});
```

Expose it from a normal route:

```ts
// routes/live.ts
import { defineHandler } from 'void';
import { live } from '../src/live';

export const GET = defineHandler((c) => live.connect(c));
export const POST = defineHandler((c) => live.control(c));
```

`GET` opens the SSE connection. `POST` accepts subscribe and unsubscribe control
operations for that connection.

## Subscribe From The Browser

Use the browser helper from `void/live/client`:

```ts
import { connectLiveStream } from 'void/live/client';

const stream = connectLiveStream('/live', {
  withCredentials: true,
  retryDelay: 1_000,
  onError(error) {
    console.error(error);
  },
});

const unsubscribePost = await stream.subscribe({
  id: 'post-card',
  topic: 'post:12',
  onEvent(event) {
    if (event.type === 'updated') {
      console.log(event.data);
    }
  },
});

const unsubscribeComments = await stream.subscribe({
  id: 'comments',
  topic: 'comment:2323',
});

await unsubscribeComments();
await unsubscribePost();
stream.close();
```

The helper opens one native `EventSource`, waits for it to open, then sends
batched `POST` control operations. Subscription ids are scoped to the
connection. Reusing an id replaces the previous subscription with that id. If
the transport drops, the helper reconnects and resubmits active subscriptions
with their latest `eventId` as `lastEventId`.

## Publish

Publish from any server-side code that has a Void runtime env:

```ts
import { live } from '../src/live';

await live.publish(
  'post:12',
  { title: 'Updated title' },
  { type: 'updated', eventId: 'post-12-v8' },
);
```

Choose your own topic names and JSON payloads. Void includes `type` and `eventId` in the event envelope without interpreting or storing them. It doesn't use native SSE `id` fields.

If you are outside an active request/runtime context, pass env explicitly:

```ts
await live.withEnv(env).publish('post:12', { title: 'Updated title' });
```

## Authorization

Every live connection has an owner. The owner is the identity allowed to send
control operations for that SSE connection. `connect()` resolves and stores the
owner; `control()` resolves the owner again and rejects the request if it does
not match.

The quickstart uses an anonymous stream:

```ts
export const live = defineLiveStream({
  id: 'app',
  allowAnonymousControl: true,
});
```

For authenticated streams, pass the same owner key to `connect()` and
`control()`:

```ts
return live.connect(c, { owner: `user:${session.userId}` });
return live.control(c, { owner: `user:${session.userId}` });
```

If every route should derive ownership the same way, define it once with
`identifyConnection`:

```ts
export const live = defineLiveStream({
  id: 'app',
  async identifyConnection(ctx) {
    const session = await getSession(ctx.request);
    return session ? `user:${session.userId}` : null;
  },
});
```

Then the route handlers can stay thin:

```ts
export const GET = defineHandler((c) => live.connect(c));
export const POST = defineHandler((c) => live.control(c));
```

When `identifyConnection` returns `null` or `undefined`, Void falls back to the
current authenticated user and uses `user:${user.id}` when the user has a string
`id`. If neither path produces an owner and `allowAnonymousControl` is not set,
the request is rejected with `403`.

For stream-local subscription rules, use `onSubscribe`:

```ts
export const live = defineLiveStream({
  id: 'app',
  async onSubscribe(ctx) {
    const match = /^post:(.+)$/.exec(ctx.topic);
    if (match && !(await canReadPost(ctx.env, ctx.user, match[1]))) {
      return new Response('Forbidden', { status: 403 });
    }
  },
});
```

## Limits

`void/live` is designed for small and medium fanout. By default, a stream allows:

- `256` active subscriptions per browser connection
- `256` active subscriptions per topic
- `100` subscribe or unsubscribe operations per control request
- `100` queued events per connection
- `64 KiB` per encoded event envelope

Each active topic supports up to 256 subscriptions, regardless of how many topic names your app uses. For example, `post:${postId}` gives each post its own subscriber limit. A user with two open tabs can count twice.

You can lower limits per stream:

```ts
export const live = defineLiveStream({
  id: 'app',
  limits: {
    maxSubscriptionsPerTopic: 64,
  },
});
```

`maxSubscriptionsPerTopic` cannot be raised above `256`. For larger broadcasts, split subscribers across application topics or use a dedicated realtime system.

## Delivery Semantics

Live delivery is at most once: clients may miss events, and Void doesn't replay them automatically.

- one SSE connection can hold many topic subscriptions
- publish cost is proportional to subscribers of the topic
- events are ordered within one topic
- clients using the raw HTTP protocol must resubscribe after reconnect
- deploys, rollbacks, Worker restarts, browser reconnects, and network changes
  can drop live state
- your app handles replay, cache invalidation, live queries, and client state

Use an application database, queue, or custom Durable Object for replay. Use
`eventId` and caller-provided `lastEventId` values as application protocol
fields when you build that layer.
