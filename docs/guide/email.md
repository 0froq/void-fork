---
outline: deep
---

# Email

Send transactional email from your app via [Cloudflare's `send_email` binding](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/). Import `sendEmail` from `void/email` and Void handles MIME construction, binding inference, and a local-dev inbox.

```ts
import { sendEmail } from 'void/email';

const result = await sendEmail({
  from: 'Acme <acme+noreply@mail.example.com>', // use your project's sender address
  to: 'user@example.com',
  subject: 'Welcome',
  text: 'Thanks for signing up!',
  // html: '<p>Thanks for signing up!</p>', // optional — sent as multipart/alternative when paired with text
});

if (!result.ok) {
  if ('error' in result) {
    // A request-level failure; OUTCOME_UNKNOWN may already have been submitted.
    console.error(result.error.code, result.error.message);
  } else {
    // Some recipients failed. `deliveries` says which.
    for (const d of result.deliveries.filter((d) => !d.ok)) {
      console.error(d.recipient, d.error.code, d.error.message);
    }
  }
}
```

Check both failure shapes: `result.error` reports a request failure, while `result.deliveries` reports failures for individual recipients. An unverified recipient fails in `deliveries`.

## Setup

On a platform with email enabled, deploy without additional email configuration. Ask your administrator for its shared mail domain. Administrators [enable email during installation or upgrade](/guide/platform/installation/credentials#runtime-token-permissions); Void Cloud uses `mail.void.cloud`.

Each project on an email-enabled platform has:

- **Default sender:** `<your-slug>+noreply@<mail-domain>`. Older projects with slugs longer than 56 characters must pass `from` explicitly.
- **Your account email as a recipient:** it is registered when the project is created. If Cloudflare has not verified it for the platform, follow the emailed verification link and run `void email destinations` before sending to it.

The shared sender can send only to verified recipients. Verify your own address or [add another recipient](#adding-recipients) before sending.

Deploying to your own Cloudflare account instead (`void deploy --platform cloudflare`) takes one line of `void.config.ts` and one Enter on the first deploy — see [Your own Cloudflare account](#your-own-cloudflare-account).

## Adding recipients

Cloudflare's `send_email` binding only delivers to addresses you've registered as recipients. Add them with the CLI:

```sh
void email allow user@acme.com
```

Cloudflare emails the recipient with a verification link. Once they click it and `void email destinations` has picked the click up, you can send to that address from your project. If the link did not arrive or has expired, run `void email allow <address>` again while the address is still pending — the CLI re-sends the link, or tells you how to get a fresh one. List the project's recipients:

```sh
void email destinations
```

The project owner's account email is added automatically when the project is created on an email-enabled platform, so it skips `void email allow` — not the verification. See [Setup](#setup) for when it is verified at once and when there is a link to click.

::: warning When this is the right fit
The shared sender suits team alerts, project notifications, and replies to inbound mail.

For mail to arbitrary users, [register your own domain](#your-own-domain-on-the-platform), use [Workers Paid on your own Cloudflare account](#your-own-cloudflare-account), or call another email provider from your handler.
:::

## Your own domain on the platform

The shared sender uses the platform's configured mail domain. To send — and receive — at a domain you own, register its Cloudflare zone with the project:

```sh
void email domain add acme.com
```

`add` opens a Cloudflare API-token template. Restrict the token to the selected account and mail zone before creating it; Workers Scripts permission applies across that account. The CLI accepts a masked paste or a newly copied token and asks you to confirm those restrictions. The platform encrypts the credential for the zone connection, so projects sharing that zone do not need separate ingress Workers.

Platform-managed custom inbound email requires the apex of a Cloudflare zone. Cloudflare’s catch-all only covers that apex, so a subdomain of the selected zone cannot receive arbitrary addresses. Choose an apex without another mail provider, or use the platform’s shared mail address. Void preserves foreign MX records and enabled catch-alls. Each custom apex belongs to one project; a project can register more than one apex.

Setup returns an operation ID. If your connection drops, the platform keeps the recorded operation and the CLI checks that operation's status. An uncertain Cloudflare write stops conflicting changes until its outcome can be established.

`void email domain status <domain>` reports three independent results:

- **Inbound**: whether mail can reach the project's handlers.
- **Outbound**: whether sending is ready, restricted to verified destinations, pending, or blocked.
- **Management**: whether the stored Cloudflare credential can manage the connection.

Use `void email domain sync <domain>` to reconcile setup and refresh readiness. Sync does not rotate the connection secret. Use `void email domain rotate-secret <domain>` for an explicit rotation; it applies to all domains sharing that zone connection and verifies the deployed secret before completing. Rotation requires inbound readiness; run `sync` first if setup is incomplete. If a dashboard or credential step is required, the status names it. Removing a domain disables its assignment; zone resources used by another domain remain in place, and unfinished cleanup stays recorded for reconciliation.

After the last assignment's ingress is deleted, the platform forgets its stored
credential. Revoke a token you no longer use in Cloudflare; Void does not revoke
tokens you created yourself. Re-adding a removed domain requires a scoped token
again. A domain can move to another project only after its removal completes
and the zone connection's manager authorizes the new assignment.

Once inbound is ready, mail to any address on that domain reaches your `email/` handlers. Sending to arbitrary recipients also needs outbound readiness; a domain limited to verified destinations still requires recipient verification. Platform quotas and suspension apply to both shared and custom senders.

On an administrator-managed platform, `add` prints the administrator command for new domains. Existing owner-managed connections remain available to their owner. Your administrator may permit shared-sender mail to specific recipient domains or any recipient; destinations on the platform's shared mail domain still require explicit verification.

## Options

| Option           | Type                         | Notes                                                                                                           |
| ---------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `from`           | `string \| { email, name? }` | Optional. Pinned to the project sender — see below.                                                             |
| `to`             | `Address \| Address[]`       | Required. One or more recipients.                                                                               |
| `subject`        | `string`                     | Required. UTF-8 supported (encoded as RFC 2047).                                                                |
| `text`           | `string`                     | At least one of `text` / `html` is required.                                                                    |
| `html`           | `string`                     | Sent as `multipart/alternative` if both are provided.                                                           |
| `replyTo`        | `Address`                    | Optional `Reply-To` header.                                                                                     |
| `cc`, `bcc`      | `Address \| Address[]`       | Optional. Each recipient is sent its own message envelope.                                                      |
| `headers`        | `Record<string, string>`     | Custom headers; reserved headers (From, Date, etc.) are ignored.                                                |
| `attachments`    | `Attachment[]`               | See [Attachments](#attachments).                                                                                |
| `idempotencyKey` | `string`                     | Optional on the Void Platform: 1–128 printable, non-space ASCII characters. Reuse for retries of the same send. |

You can send to at most 50 recipients across `to`, `cc`, and `bcc`. Addresses must have an ASCII local part of at most 64 characters and a dotted domain; the whole address can be at most 254 characters. Quoted local parts, `user@localhost`, and malformed dots are rejected. Use punycode for internationalized domains. Void returns `INVALID_TO` for an invalid `to`, `INVALID_FROM` for `from`, and `MIME_ERROR` for `cc`, `bcc`, `replyTo`, or invalid custom header names.

`Address` accepts either a string (`"hello@acme.dev"` or `"Name <hello@acme.dev>"`) or an object (`{ email, name? }`). Display names with non-ASCII characters are RFC 2047 encoded automatically.

On the platform the sender is pinned to your project. `from` must be your project's own platform address — `<project-slug>@<mail-domain>` or `<project-slug>+<tag>@<mail-domain>`, optionally with a display name — or any address on a domain registered with `void email domain add` (see [Your own domain on the platform](#your-own-domain-on-the-platform)). For example, if your platform's mail domain is `mail.example.com`, you can use `Acme <acme+noreply@mail.example.com>`. Anything else is rejected with `INVALID_FROM`. Omit `from` and Void fills in `<project-slug>+noreply@<mail-domain>` for you.

On your own Cloudflare account, `from` defaults to `email.from` from `void.config.ts` and must be on a domain your account can send from; Cloudflare rejects any other sender and `sendEmail` reports it as `INVALID_FROM`.

## Attachments

```ts
await sendEmail({
  to: 'user@example.com',
  subject: 'Your receipt',
  text: 'Receipt attached.',
  attachments: [
    {
      filename: 'receipt.pdf',
      content: pdfBytes, // string | Uint8Array | ArrayBuffer | Blob
      contentType: 'application/pdf',
    },
  ],
});
```

For inline images (e.g. logos referenced from HTML), set `disposition: 'inline'` and `contentId`:

```ts
await sendEmail({
  to: 'user@example.com',
  subject: 'Hello',
  html: '<img src="cid:logo" alt="Acme">',
  attachments: [
    {
      filename: 'logo.png',
      content: logoBytes,
      contentType: 'image/png',
      contentId: 'logo',
      disposition: 'inline',
    },
  ],
});
```

Void infers `contentType` from the filename if you omit it. An explicit value must be a valid media type. `contentId` names the image referenced by `cid:<id>` in HTML; use an ID such as `logo` or `logo@acme.dev`. The encoded message is limited to 5 MiB and custom headers to 16 KiB. Invalid attachment fields or oversized messages return `MIME_ERROR`.

## Result and errors

`sendEmail` returns a result instead of throwing. A successful result means the provider accepted the send; it does not confirm delivery to the recipient's mailbox.

`ok: true` carries `ids`, one per unique recipient. Addresses are compared case-insensitively across `to`, `cc`, and `bcc`. A custom-domain provider batch can report the same provider reference for several recipients.

`ok: false` carries either a top-level `error` or a complete per-recipient `deliveries` list. Platform results include an `operationId` when available, and per-recipient `state` distinguishes rejection, reservation, submission, provider acceptance, failure, cancellation, and an unknown outcome.

Provider submissions have a 30-second wait limit. Platform `sendEmail` requests are bounded to 60 seconds, including admission and recording the result; native and inbound handler submissions share a 60-second batch budget. A submission that times out returns `OUTCOME_UNKNOWN`; the provider may still accept it later.

Use an idempotency key for sends you may retry:

```ts
const result = await sendEmail({
  to: 'user@example.com',
  subject: 'Invoice ready',
  text: 'Your invoice is available in your account.',
  idempotencyKey: 'invoice:42:ready',
});

if (result.ok) {
  console.log('Accepted by the provider', result.operationId);
} else {
  console.log('Inspect the outcome before retrying', result.operationId, result);
}
```

For 30 days, repeating a key with the same payload returns its recorded outcome without another provider submission. Reusing it with a different payload returns `IDEMPOTENCY_CONFLICT`. A lost response or interrupted provider request can return `OUTCOME_UNKNOWN`; check `void email logs` or repeat the same key. A new key creates a new send and can produce a duplicate. Native Cloudflare binding sends do not support platform idempotency keys.

| Code                     | Meaning                                                        |
| ------------------------ | -------------------------------------------------------------- |
| `BINDING_MISSING`        | No email transport is configured.                              |
| `INVALID_FROM`           | The sender is invalid or not authorized for the project.       |
| `INVALID_TO`             | The recipient list is invalid or exceeds 50 recipients.        |
| `UNVERIFIED_DESTINATION` | The recipient needs verification under the active policy.      |
| `MIME_ERROR`             | The message is invalid or exceeds a size limit.                |
| `QUOTA_EXCEEDED`         | A platform or provider quota has been reached.                 |
| `IDEMPOTENCY_CONFLICT`   | The key was already used for another payload.                  |
| `OUTCOME_UNKNOWN`        | The send may have reached the provider; do not blindly resend. |
| `UPSTREAM_ERROR`         | The provider or platform refused the request.                  |

The default platform allowance is 200 recipient submissions per UTC month and 10 per rolling minute. Reserved and started submissions count toward the limits; a started attempt stays charged even if it fails or its outcome is unknown. Administrators can change these limits.

`void email usage` shows monthly recipient attempts, inbound receipts, and the remaining allowance. `void email logs --limit 50` shows up to 100 recent metadata entries retained for 30 days: operation, recipient, direction, state, provider reference, and error code. It does not store subjects, bodies, or attachments. Receiving a message and sending a reply are separate events.

## Local development

During `void dev`, sends are captured to an in-memory inbox instead of going to Cloudflare. The dev server prints the inbox URL when it starts:

```
[void] Email inbox: http://localhost:5173/__void/inbox?token=<printed-token>
```

The inbox shows a list view with subject, sender, recipient, and timestamp. Click a message to see headers, attachments, and an HTML preview rendered in a sandboxed iframe. Each message can be downloaded as a `.eml` file.

Every inbox route requires a local access token. Void includes it in the printed inbox URL and browser links. For command-line requests, send it in the `x-void-dev-trigger` header as shown below; requests without it return `401`. The token is stored in `.void/dev-trigger-token`. Treat inbox URLs as credentials, especially when exposing your dev server to a network.

```bash
# download a message as .eml
curl http://localhost:5173/__void/inbox/<id>/raw \
  -H "x-void-dev-trigger: <printed-token>" -o message.eml

# clear the inbox
curl -X DELETE http://localhost:5173/__void/inbox \
  -H "x-void-dev-trigger: <printed-token>"
```

The inbox keeps the most recent 100 messages through HMR and clears on a full server restart.

The dev inbox works in native Void apps, TanStack Start, and React Router. It is unavailable in SvelteKit, Nuxt, Analog, and Astro; sends from those apps return `BINDING_MISSING`. Use `createEmailTestHarness` from `void/email/testing` to capture sends in tests. If a configured inbox cannot be reached, `sendEmail` returns `UPSTREAM_ERROR` without sending.

`sendInDev: true` skips the inbox for one call. It returns `BINDING_MISSING` in `void dev` because no live send transport is bound. Deploy the app to test real delivery.

```ts
const result = await sendEmail({
  from: 'acme+noreply@mail.example.com', // replace with your project sender
  to: 'verified@acme.dev',
  subject: 'Skips the dev inbox',
  text: 'Not captured — and not delivered either.',
  sendInDev: true,
});
// Under `void dev`: result.error.code === 'BINDING_MISSING'
```

## Testing

Use the test harness to assert on outgoing messages without mocking the binding:

```ts
import { describe, it, expect } from 'vitest';
import { sendEmail } from 'void/email';
import { createEmailTestHarness } from 'void/email/testing';

describe('signup flow', () => {
  it('sends a welcome email', async () => {
    const inbox = createEmailTestHarness();

    await sendEmail({
      from: 'acme+noreply@mail.example.com', // use your project sender
      to: 'user@example.com',
      subject: 'Welcome',
      text: 'Hi!',
    });

    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0].subject).toBe('Welcome');
    inbox.dispose();
  });
});
```

The harness intercepts every `sendEmail` call until `dispose()` is called. `clear()` empties the captured list without releasing the sink.

## Inbound

Inbound mail is a **Void-app-only** feature. Receive it by dropping handlers in the top-level `email/` directory — alongside `crons/` and `queues/`. Void detects them, generates the worker's `email()` export, and dispatches incoming messages by recipient address.

Under a third-party framework — TanStack Start, React Router, SvelteKit, Nuxt, Analog, Astro — Void wires only crons and queues into the framework's own worker entry, so there is nowhere to attach an `email()` export. An `email/` directory in those projects is a build error, not silently dead code. Outbound is unaffected: `sendEmail` is a binding, and it works in every framework.

The same holds for `target: "node" | "bun" | "deno"`: those builds expose HTTP only and never invoke an `email()` export, so an `email/` directory fails the build with guidance.

```ts
// email/_default.ts — fallback for any unmatched recipient
import { defineEmail, parseEmail } from 'void/email';

export default defineEmail(async (message, env, ctx) => {
  const parsed = await parseEmail(message);

  if (parsed.subject?.startsWith('STOP')) {
    message.setReject('Use the unsubscribe link.');
    return;
  }

  await message.forward('archive@example.com');
});
```

The handler receives Cloudflare's native `ForwardableEmailMessage` plus an optional fourth `info` arg with `params` populated for dynamic / tagged route segments:

| Method                             | Purpose                                                                                                                                                                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message.setReject(reason)`        | Reject the message — the sender sees the SMTP error. The reason is cut to 1000 characters and control characters become spaces; an empty one reads `rejected by handler`.                                                                            |
| `message.forward(to, hdrs?)`       | Forward to a verified destination address. `to` is a bare address; one `sendEmail` would refuse throws `INVALID_TO` at the call. `hdrs` holds at most 32 headers, each name and value at most 1024 characters; more throws `MIME_ERROR` at the call. |
| `replyEmail(message, opts)`        | Reply with a threaded `In-Reply-To` / `References`.                                                                                                                                                                                                  |
| `message.reply({ from, to, raw })` | Bring your own MIME bytes (`Uint8Array` or stream). `from` and `to` are bare addresses, checked at the call like `forward`. A native `EmailMessage` cannot be replayed — its body has no public accessor.                                            |
| Returning without action           | Accept the message silently.                                                                                                                                                                                                                         |

`parseEmail(message)` wraps [`postal-mime`](https://www.npmjs.com/package/postal-mime) and returns a structured object with `from`, `to`, `subject`, `text`, `html`, `attachments`, and full `headers`. Call it at most once per message — the underlying stream can only be read once.

### Per-recipient routing

```
email/
  support.ts                — handles support@<your-domain>
  billing.ts                — handles billing@<your-domain>
  support+[ticket].ts       — handles support+ticket-123@... → info.params.ticket = "ticket-123"
  support+vip.ts            — handles exactly support+vip@..., ahead of support+[ticket].ts
  [user].ts                 — dynamic local-part   → info.params.user
  [user]+[tag].ts           — dynamic + subaddress → info.params.user, info.params.tag
  _default.ts               — fallback when no per-address pattern matches
```

Files are matched against the local-part of the `To` address (the portion before `@`), case-insensitive. **Match precedence (most specific wins):**

1. `support+vip.ts` (static + literal tag)
2. `support+[ticket].ts` (static + captured tag)
3. `support.ts` (static)
4. `[user]+vip.ts` (dynamic + literal tag)
5. `[user]+[tag].ts` (dynamic + captured tag)
6. `[user].ts` (dynamic)
7. `_default.ts` (fallback)

The first pattern that matches wins. Within a shape, a literal tag beats a captured tag — `support+vip@` reaches `support+vip.ts`, and every other `support+…@` reaches `support+[ticket].ts`. Handlers of the same shape are tried alphabetically.

If nothing matches and there's no `_default.ts`, control returns to Cloudflare and the sender receives a non-delivery report. Nested folders under `email/` are ignored — the recipient is a flat string, not a path.

### Threaded replies

```ts
// email/support+[ticket].ts
import { defineEmail, parseEmail, replyEmail } from 'void/email';

export default defineEmail(async (message, env, ctx, info) => {
  const parsed = await parseEmail(message);
  await ticketStore.append(info!.params.ticket, parsed.text ?? '');

  await replyEmail(message, {
    text: `Got your message on ticket ${info!.params.ticket}.`,
  });
});
```

`replyEmail` builds the reply MIME with `Subject: Re: <original>` (no double-prefix), `In-Reply-To: <Message-ID>`, and a continued `References` chain, then dispatches through the message's `reply()`. Defaults: `to = message.from`, `subject = "Re: <original>"`.

Void uses the inbound message's `Message-ID` and `References` when they fit in reply headers. It drops unusable values and falls back to a bare `Re:` for a subject it cannot safely reuse. Pass `subject` to set it explicitly.

On the platform, shared-domain replies default to
`<slug>+noreply@<mail domain>`. For mail received at a registered custom domain,
replies default to the address that received the message. `replyEmail` throws
when it cannot determine a sender. Native Cloudflare replies default to `message.to`.

::: warning The platform pins the reply sender
You may override `from` with your project's shared address or an address on
a registered custom domain your project owns. An unauthorized sender is rejected
and recorded in `void email logs`.

For shared addressing, `message.to` has the project prefix removed. Use the
default sender instead of copying that stripped address into `from`.
:::

::: warning The platform gates the reply recipient
A reply's `to` goes through the platform's recipient policy and the transport's
capability checks. Shared sending defaults to your project's verified
destinations: run `void email allow <address>` and have the recipient complete
verification. A blocked reply is recorded in `void email logs`; the inbound
message remains accepted.

Custom-domain sends may reach external recipients when Cloudflare Sending is
enabled. Addresses on the platform's own mail domain always require per-project
consent. Native forwarding and reply operations can have additional Cloudflare
restrictions; check the recorded outcome before assuming a reply was accepted.
:::

In a platform handler, awaiting `replyEmail` or `message.forward` records an
action for execution after the handler finishes. Use `void email logs` to see
its provider outcome. `sendEmail` returns its send result directly.

`message.forward` requires a native Cloudflare email event. A message relayed
from a customer zone cannot use native forwarding; its forward action is
recorded as `UNSUPPORTED_ACTION` without sending or consuming quota. Replies
remain available through that domain's sending capability.

### Configuring inbound delivery

On an email-enabled platform, `<slug>+anything@<mail domain>` reaches your
deployed `email/` handlers without per-project DNS setup once the platform has verified your recipient rule and enabled plus addressing. Void sets up that rule when you deploy handlers; creating a project or only sending mail requires no inbound rule. Deployment reports a routing conflict or capacity limit if setup cannot complete. A
[registered custom domain](#your-own-domain-on-the-platform) reaches those
handlers once its inbound readiness is `ready`. Use `void email domain status`
to check current provider routing and any remaining setup steps.

On your own Cloudflare account there is no shared facility: the deploy derives one Email Routing rule per handler and records it in `void.lock.json` for you — see [Your own Cloudflare account](#your-own-cloudflare-account).

There is no local inbound trigger yet — `void dev` serves the outbound dev inbox only, so test inbound handlers with `createInboundTestHarness` below.

### Testing inbound handlers

Use `createInboundTestHarness` to run handlers through the real dispatcher with a synthesized message and capture replies / forwards / rejects.

`deliver({ to })` takes the address **as it arrives on the wire**, which is
`<slug>+<tag>@<domain>` — the same form the platform delivers to your worker.
The harness strips the `<slug>+` prefix before matching, exactly as the
generated dispatcher does on the platform, so `acme+support+abc-123@acme.dev`
is what matches `email/support+[ticket].ts`. Pass the user-facing
`support+abc-123@acme.dev` and the harness reads `support` as the slug, leaving
`abc-123` to match — which falls through to `_default`. A worker on your own
Cloudflare account receives no slug and matches the full local part; pass
`slug: null` to test that lane, and `support@mail.acme.com` reaches
`email/support.ts` while `support+abc-123@mail.acme.com` reaches
`email/support+[ticket].ts` with `abc-123`:

```ts
const harness = createInboundTestHarness({
  slug: null,
  routes: { support, 'support+[ticket]': ticket },
});
await harness.deliver({ from: 'a@x.dev', to: 'support+abc-123@mail.acme.com' });
```

```ts
import { describe, it, expect } from 'vitest';
import { createInboundTestHarness } from 'void/email/testing';
import support from './email/support+[ticket]';
import defaultHandler from './email/_default';

describe('email handlers', () => {
  it('routes to support+[ticket] and extracts the tag', async () => {
    const harness = createInboundTestHarness({
      routes: { 'support+[ticket]': support, _default: defaultHandler },
    });
    const result = await harness.deliver({
      from: 'user@example.com',
      to: 'acme+support+abc-123@acme.dev',
      subject: 'Help',
      text: 'I have a problem',
    });
    expect(result.handler).toBe('support+[ticket]');
    expect(result.params).toEqual({ ticket: 'abc-123' });
  });

  it('rejects STOP messages via _default', async () => {
    const harness = createInboundTestHarness({ routes: { _default: defaultHandler } });
    await harness.deliver({
      from: 'user@example.com',
      to: 'acme+unknown@acme.dev',
      subject: 'STOP',
      text: 'bye',
    });
    expect(harness.rejects).toEqual(['Use the unsubscribe link.']);
  });
});
```

The harness uses the same precedence rules as the production dispatcher. Reserved key `_default` mirrors `email/_default.ts`. It also applies the platform's inbound admission limits before your handler runs: a message over 10 MiB, or carrying more than 1024 headers or 128 KiB of header data, is recorded in `rejects` and the handler is not called — exactly what the platform does before dispatch. With `slug: null` there is no platform router in front of the worker, so neither limit applies.

## Your own Cloudflare account

Set a sender on a Cloudflare zone you own:

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  email: { from: 'Acme <support@mail.acme.com>' },
});
```

Use a mail subdomain to keep existing mail on `acme.com` with its current provider. Void refuses to replace another provider's MX records.

### Setup

Sign in with `void cloudflare login`, or use a `CLOUDFLARE_API_TOKEN` with **Email Routing Edit** and **Email Sending Edit** in addition to deploy permissions. If your browser session lacks email permissions, log out and sign in again. Global API Keys aren't supported.

Run `void deploy --platform cloudflare`. Void shows the domain, routing, sending, DNS, and handler addresses it would configure. Accept to set up email and deploy. Later deploys reuse the setup. Without `email.from`, or if you decline the initial setup, the app deploys without email.

If subdomain setup needs a dashboard step, follow the checklist under **Email → Settings → Subdomains**, then retry. After DNS changes, check readiness with:

```sh
void email status --platform cloudflare
```

### Inbound addresses

With `email.from` on `mail.acme.com`, handlers receive:

| Handler                             | Subdomain address       | Zone apex address  |
| ----------------------------------- | ----------------------- | ------------------ |
| `support.ts`, `support+[ticket].ts` | `support@mail.acme.com` | `support@acme.com` |
| `_default.ts`                       | No catch-all rule       | `*@acme.com`       |
| `[user].ts`, `[user]+[tag].ts`      | Not supported           | `*@acme.com`       |

Cloudflare catch-alls cover only a zone apex. On a subdomain, `_default.ts` can handle mail admitted by an explicit rule, but cannot receive arbitrary addresses.

Setup enables the zone's plus addressing so `support+T-42@mail.acme.com` reaches `support+[ticket].ts`. This setting also applies to the apex and other subdomains.

`replyEmail()` defaults its sender to the address that received the message. Forwarding requires a verified Cloudflare destination.

### Sending

On Workers Free, `sendEmail()` can send to verified destinations listed under **Email Routing → Destination addresses** in Cloudflare.

Sending to arbitrary recipients requires [Workers Paid](https://dash.cloudflare.com/?to=/:account/workers/plans) and Email Sending onboarding. After upgrading, run `void email setup --platform cloudflare`. Void doesn't retry onboarding during ordinary deploys.

Existing DMARC or bounce-domain records can block onboarding; the checklist identifies conflicts to resolve. Inbound mail remains available.

The `void email usage`, `logs`, `destinations`, `allow`, and `disallow` commands apply to Void platforms.

### Configuration changes

Commit `void.lock.json` after setup. Void derives routing addresses from your handlers and creates their rules during deployment.

Existing rules owned by another Worker or forwarding service are left in place. If you manage `cloudflare.addresses` yourself, follow the checklist rather than combining it with automatic email setup.

After deleting a handler, review the reported stale address and set the desired `cloudflare.addresses`. Deleting a routing rule requires confirmation in an interactive terminal.

To remove all email setup, remove `addresses`, `send_email`, and `vars.__VOID_EMAIL_FROM` from `resolved` in `void.lock.json`, remove corresponding overrides in `void.config.ts`, and delete the routing rules in Cloudflare.

### CI

Set up email locally first:

```sh
void email setup --platform cloudflare
void email status --platform cloudflare
```

Commit `void.lock.json`, then deploy in CI with:

```sh
void deploy --platform cloudflare --require-email
```

CI cannot answer setup prompts. Without `--require-email`, an unconfigured app can deploy without email. If setup is saved but DNS hasn't propagated, deployment waits for a later retry. Workers Free setup for verified recipients satisfies `--require-email`.
