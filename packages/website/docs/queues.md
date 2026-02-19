# Queues

Vite Cloud supports Cloudflare Queues for asynchronous message processing from a top-level `queues/` directory.

## Defining queues

Create files in `queues/**/*.ts` (`.mts`, `.js`, `.mjs` also supported). The queue name is inferred from the filename — `queues/emails.ts` creates a queue named `"emails"`, and `queues/order/notifications.ts` creates `"order/notifications"`.

Each queue file should export a default handler wrapped with [`defineQueue`](./api.md#definequeuet-handler). The generic `<T>` parameter defines the message body type — this is the type of each `msg.body` in the batch and is used by the typed `queues` proxy for `send()` calls.

```ts
// queues/emails.ts
import { defineQueue } from "vite-cloud";

interface Message {
  to: string;
  subject: string;
}

export default defineQueue<Message>(async (batch, env) => {
  for (const msg of batch.messages) {
    console.log(`Send to ${msg.body.to}: ${msg.body.subject}`);
  }
});
```

Files or directories starting with `_` are ignored.

## Sending messages

Import the typed `queues` proxy from `vite-cloud/queues` to send messages. Each queue is available as a property matching its name, with full type safety from the consumer's `defineQueue<T>` generic.

```ts
// routes/api/orders.ts
import { defineHandler } from "vite-cloud";
import { queues } from "vite-cloud/queues";

export const POST = defineHandler(async (c) => {
  const order = await c.req.json();
  // Fully typed — body must match the
  // Message interface from queues/emails.ts
  await queues.emails.send({
    to: order.email,
    subject: "Order confirmed",
  });
  return c.json({ ok: true });
});
```

The binding name is derived automatically: `QUEUE_` + queue name uppercased with non-alphanumeric characters replaced by `_`. For example, `queues/emails.ts` creates binding `QUEUE_EMAILS`.

## Consumer options

You can export `maxBatchSize` and `maxBatchTimeout` to configure how Cloudflare delivers batches to your consumer:

```ts
// queues/emails.ts
import { defineQueue } from "vite-cloud";

interface Message {
  to: string;
  subject: string;
}

export const maxBatchSize = 50;
export const maxBatchTimeout = 10; // seconds

export default defineQueue<Message>(async (batch, env) => {
  for (const msg of batch.messages) {
    console.log(`Send to ${msg.body.to}: ${msg.body.subject}`);
  }
});
```

- `maxBatchSize` — Maximum number of messages per batch (default: 10)
- `maxBatchTimeout` — Maximum seconds to wait before delivering an incomplete batch (default: 5)

## Deployment behavior

On deploy, Vite Cloud includes all discovered queues in the deploy manifest. The platform provisions Cloudflare Queues, configures producer bindings on the user worker, and registers the dispatch worker as the queue consumer for relay delivery.

## Local development

In local dev, Miniflare delivers queue batches natively. The worker's `queue()` export serializes the batch and routes it to the same internal `/__queue` handler used in production, so behavior is consistent across environments.
