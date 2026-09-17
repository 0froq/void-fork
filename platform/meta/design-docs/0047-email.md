---
title: Email — Send & Receive via Resend
status: superseded
created: 2026-03-03
superseded_by: 0078-email-cf-native.md
---

> **Superseded on 2026-08-30 by [Cloudflare-native email](./0078-email-cf-native.md).**
> The implementation uses Email Routing, Email Workers and the `send_email`
> binding. This record preserves the earlier webhook-based design.

# Email — Send & Receive via Resend

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

**Unified proxy auth:** The idea of unifying all proxy bindings (`__PROXY` + `__PROXY_TOKEN` replacing `__AI_PROXY` + `__AI_TOKEN`) is independently valuable and should be done when the next platform service is added.

---

## Original Design (preserved for future reference)

### Framework API

**Sending:**

```ts
import { sendEmail } from 'void/email';

await sendEmail({
  from: 'Acme <noreply@myapp.com>',
  to: ['user@example.com'],
  subject: 'Welcome!',
  html: '<h1>Welcome to Acme</h1>',
});
```

**Receiving** (handler at `routes/_email.ts`):

```ts
import { onEmail } from 'void/email';

export default onEmail(async (message) => {
  // message.from, message.to, message.subject, message.html, message.text, message.attachments
});
```

### Architecture

Outbound: user code → `void/email` → `__PROXY` service binding → proxy worker → Resend API (metered via Analytics Engine).

Inbound: Resend webhook → `api.platform.example.net/webhooks/resend` → fetch full body → `POST {slug}.apps.example.com/_void/email` via dispatch → `onEmail` handler.

Domain setup via CLI (`void domain setup-email`, `void domain verify-email`). Schema extends `domains` table with `resend_domain_id` and `email_status` columns.

Metering via Analytics Engine + `UsageCounter` DO enforcement (same pattern as AI). Initial limit: 100 emails/month all tiers.
