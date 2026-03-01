---
outline: deep
---

# AI

Void provides a typed AI client powered by [Workers AI](https://developers.cloudflare.com/workers-ai/). Import `ai` from `void/ai` and run inference models directly from your route handlers — all usage is metered via Void with no Cloudflare account or API keys required.

```ts
import { ai } from "void/ai";
```

## Basic Usage

Call `ai.run()` with a model name and inputs. Model names and input types are fully typed from `@cloudflare/workers-types`.

```ts
import { defineHandler } from "void";
import { ai } from "void/ai";

export const POST = defineHandler(async (c) => {
  const { prompt } = await c.req.json();

  const result = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [{ role: "user", content: prompt }],
  });

  return c.json(result);
});
```

You can use any model available on [Workers AI](https://developers.cloudflare.com/workers-ai/models/) — text generation, image classification, embeddings, translation, and more.

## Streaming

Use `ai.stream()` to get a streaming response with SSE headers — ready to return directly from a route handler:

```ts
import { defineHandler } from "void";
import { ai } from "void/ai";

export const POST = defineHandler(async (c) => {
  const { prompt } = await c.req.json();

  return ai.stream("@cf/meta/llama-3.1-8b-instruct", {
    messages: [{ role: "user", content: prompt }],
  });
});
```

`ai.stream()` calls `ai.run()` with `stream: true` and wraps the result in a `Response` with `content-type: text/event-stream` and `cache-control: no-cache` headers.

## Listing Models

Use `ai.models()` to list available models:

```ts
const models = await ai.models();

// Filter by task
const textModels = await ai.models({ task: "Text Generation" });
```

## Markdown Conversion

Use `ai.toMarkdown()` to convert documents to markdown:

```ts
const result = await ai.toMarkdown([{ name: "document.pdf", blob: pdfBytes }]);
```

## Local Development

AI requires Void credentials for local development. Run `void auth login` and `void project link` (or follow the interactive setup during `vite dev`) to connect your project.

Once linked, credentials are injected automatically as worker bindings — no manual configuration needed. All inference traffic routes through the Void AI proxy over HTTPS, so usage is tracked and metered the same way as in production.

## How It Works

The AI binding is auto-detected when your code imports `void/ai`. No configuration is needed.

At runtime, the `ai` client resolves its backend in priority order:

1. **Service binding** (production) — direct service binding to the AI proxy worker, zero-latency within Cloudflare's network
2. **HTTPS proxy** (local dev) — authenticated requests to the Void AI proxy using your login credentials
3. **Direct AI binding** (self-hosted) — falls back to `env.AI` if you're running with your own Cloudflare account and `wrangler.json`

All inference is routed through [AI Gateway](https://developers.cloudflare.com/ai-gateway/) for tamper-proof token counting and usage tracking. This is what powers per-project metering on the Void dashboard.

## Usage Limits

AI usage is metered in **neurons** — Cloudflare's unit for Workers AI inference cost. Usage resets at the start of each billing cycle. For reference, a Llama 3.1 8B chat completion costs ~40 neurons.

| Plan | Included      | At limit                           |
| ---- | ------------- | ---------------------------------- |
| Free | 100,000/month | Blocked until billing cycle resets |
| Solo | 300,000/month | Overage billed                     |
| Pro  | 500,000/month | Overage billed                     |

Paid plans include the same free neuron allowance as Cloudflare's Workers AI free tier (10,000 neurons/day).

On the **free tier**, AI requests return a `429` error once the limit is reached. Usage resets automatically at the start of the next billing cycle.

On **paid tiers** (Solo, Pro), there is no hard block — usage beyond the included allowance is tracked as overage on your monthly bill.
