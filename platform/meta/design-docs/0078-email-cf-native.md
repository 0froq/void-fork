---
title: Cloudflare-Native Email Decisions
status: implemented
created: 2026-04-24
updated: 2026-09-17
---

# Cloudflare-native email decisions

The [email guide](../../../docs/guide/email.md) describes the supported API and
setup. This record preserves the trust boundaries, lifecycle decisions and
accepted limitations behind that implementation. The earlier Resend/webhook
proposal, re-land transcript, copied source and unimplemented setup recipes
are retired.

## Hosting modes and lifecycle

### Mode A — managed platform

The platform proxy owns the account-level `send_email` binding. Tenant
Workers receive only the authenticated `__VOID_PROXY` interface; giving
them a raw send binding would bypass destination consent, suspension and
quota policy. Native Cloudflare Workers use their own account binding.

The mail domain is configured per environment as `EMAIL_SENDER_DOMAIN`
and injected as `__VOID_EMAIL_DOMAIN`. Missing configuration fails closed.
There is one project-slug binding, `__VOID_PROJECT_SLUG`. Senders must
belong to that project's namespace on the configured mail domain.

#### Verified destinations

Cloudflare's account-level verification does not establish consent for every
project on the account. Preserve the distinction recorded in
`email_destinations.verification_source`:

- **Option C — owner-relaxed reuse:** an already verified address matching
  the current project owner's email can inherit that owner's consent.
- **Option B — platform confirmation:** an address verified for another
  project remains pending until the recipient follows this project's
  signed confirmation link. A Cloudflare refresh cannot bypass this gate.
- A newly registered Cloudflare destination is promoted only when the
  verified tag matches the project's registration. An unrelated recreation
  of the same address does not prove this project's consent.

Owner inheritance must recheck the captured owner email inside the transaction
that writes or promotes the destination. Owner-email changes revoke inherited
consent and tighten the allowlist without silently committing a failed
tighten. Explicit revocation and project deletion also update the mirror.

The proxy reads `email-allowlist:<projectId>` from routing KV.
Destination listing repairs a missing or inconsistent mirror from the
authoritative verified rows. Preserve fail-closed behavior when a mirror is
absent. A verified platform row is not automatically revoked by an
out-of-band Cloudflare deletion; Cloudflare still refuses actual sends until
its destination is verified again.

#### Quotas and visibility

Outbound sends and inbound forward/reply actions share destination, suspension,
burst and monthly checks. The counters use KV read-modify-write and are
best-effort under concurrency, not strict distributed admission limits.
Increasing a time window does not make those updates atomic.

Project destination listing picks up pending Cloudflare verification;
Cloudflare does not push that event into the platform. Persistent project
delivery logs are not implemented: `void email logs` reports pending support.
A handled inbound message can still have a forward or reply refused by its
outbound gate. Do not present a handled receipt as proof of delivery.

### Mode B — the developer's own Cloudflare account

Native setup is implemented in
[email-cloudflare.ts](../../../packages/void/src/cli/email-cloudflare.ts).
`void deploy --platform cloudflare` and `void email setup|status`
share its read-only preflight and selected Wrangler session. The developer
supplies `email.from`; Void does not choose another mail domain silently.

#### One keystroke

Interactive deployment displays the selected account/domain and unfinished
account changes before offering setup. Noninteractive deployment reports
unfinished setup; `--require-email` makes it a deployment prerequisite.
Ready configuration is reconciled without repeating account mutations.

The checklist distinguishes account work from config updates and routing
rules. `wrangler deploy` owns rule application; a pending rule is not
itself a reason to rerun account onboarding. A previously attempted but
refused Sending onboarding can be retried explicitly with `void email setup`.

#### The flow, by lane

1. Read domain DNS, account identity, routing settings, existing rules and
   Sending state before applying changes.
2. Enable routing only where needed. Preserve unrelated apex mail records
   when the configured sender uses a subdomain.
3. Enable the zone's `support_subaddress` setting when needed; literal
   address routing alone does not guarantee `support+tag@` delivery.
4. Attempt Sending onboarding and report plan or permission refusals without
   treating them as permission to alter unrelated records.
5. Reconcile the owned sender/binding configuration. Write `addresses`
   only when inbound routing is ready, then let pinned Wrangler apply it.
6. Print the resulting inbound map and remaining manual steps.

Use pinned Wrangler commands wherever available. For zone classification,
subdomain routing and subaddressing calls without a Wrangler command, borrow
the selected session bearer through `wrangler auth token --json` inside
the narrow request closure. Do not persist, log, include in errors, or forward
that token to a different origin. Disable Wrangler disk logging on the token
handoff. Credentialed preflight runs before evaluating project code.

The session gate checks the required email scopes for OAuth sessions.
API-token permissions are established by the actual reads; a Global API Key
is refused where the bridge requires a bearer. Prose parsers are pinned to
the bundled Wrangler version and tested against its captured output. A
parser miss yields unknown state and setup guidance, not permission to write.

Void owns the entire derived top-level `addresses` array in this mode.
Hand-written entries that it cannot derive skip setup without changing that
array. Addresses already routed elsewhere are pruned from the proposed plan.
When routing is unready, omit/delete the config key rather than writing
`[]`, which would ask Wrangler to delete owned rules. Re-read the root
config after edits and preserve the deployment verifier's whole-array check.

#### Error map and degraded branches

The code classifies known provider errors for routing-not-enabled,
already-onboarded and Sending-entitlement refusals. Unknown failures remain
diagnosable and do not authorize retries of uncertain writes.

If subdomain routing or subaddressing is refused, print the explicit
Cloudflare dashboard step and withhold `addresses` for that run.
Never claim setup is complete merely because the Worker uploaded.
Sender config and an inert send binding can remain useful for verified
destinations when arbitrary-recipient Sending is unavailable.

#### Still unverified

Keep credentialed provider acceptance separate from unit-test evidence.
Live checks must establish the subdomain routing POST and subaddressing PATCH
with the selected credential type, rule-plan permissions, conflict behavior
after dashboard edits or Worker renames, and multi-label mail subdomains.
The earlier local source probes are not evidence that these operations
succeeded in an arbitrary account. Follow the
[live release procedure](../release-acceptance.md).

### Mode C — self-hosted platform

The same proxy and consent rules apply to an operator-owned platform.
Configure its mail domain, sender, proxy binding and Email Routing before
enabling email. Core installation does not make optional email setup
automatic. Use [platform operations](../operations.md) for the supported
operator workflow.

## Cross-worker dispatch

Cloudflare's real `ForwardableEmailMessage` is not serializable over RPC.
The proxy buffers a bounded envelope and calls the tenant's
`WorkerEntrypoint.email()`; the generated handler returns action intents.
The proxy validates and enacts those intents against the original message.

Keep the wire recipient as `__voidPlatformTo` for dispatch. Strip the
platform slug prefix exactly once for the user-facing message. Case-insensitive
matching must preserve the original case of captured parameters.

Pre-buffering bounds the inbound raw body and distinct header count before
constructing the RPC envelope. Forward/reply/reject validation also bounds
action count, address/header size and cumulative reply bytes. These are
independent limits; a raw byte cap alone permits an excessive number of
distinct short headers. Invalid actions cannot bypass the outbound gate.

### RPC result materialization — accepted limit

The tenant's entire RPC return value is materialized inside the shared proxy
before action validation. The framework's action queue constrains cooperative
handlers; an arbitrary tenant entrypoint can return another object graph.

The 2026-09-15 workerd probe established that the 32 MiB serialized RPC limit
does not bound the receiver's heap: a dense array of nulls near that cap
materialized about 128 MiB, and empty objects about 503 MiB. Those measurements
used local workerd without the production isolate-memory limit; they do not
claim a measured production eviction. The relevant provider contracts are
[RPC limits](https://developers.cloudflare.com/workers/runtime-apis/rpc/#limitations)
and [Worker memory](https://developers.cloudflare.com/workers/platform/limits/#memory).

This was accepted as an architectural limitation. Callee CPU limits reduce
some inputs but do not establish a hard caller-heap bound. Returning a string,
stream or `RpcTarget` by convention cannot constrain a hostile callee.
Possible future boundaries are a reserved HTTP endpoint with a bounded body,
a dedicated inbound-email dispatch Worker, or a separate email CPU budget.
They change the framework contract or deployment architecture and remain
separate design decisions.

## Local development and testing

The development inbox captures outbound MIME and requires the project's
dev-trigger token on every route. It is not a production send transport.
Skipping capture with `sendInDev` does not create a binding or guarantee
real delivery. Preserve the user's independently named send bindings when
removing Void's own dev transport.

Test harnesses exercise the same message construction, routing and action
semantics as production. Inbound parsing consumes a stream; handlers choose
when to parse it. Threaded replies treat sender-supplied headers as untrusted
and fall back safely when threading metadata is malformed.

## Deferred decisions

Custom sender domains on the managed platform, third-party provider wrappers,
component templates, typed sender discovery and persistent delivery logs are
not implemented by this record. Users can call a provider SDK directly where
appropriate.

Native setup currently detects email at the feature level rather than
separately onboarding inbound-only apps. Splitting that detection would also
need to handle sends from dependencies, dynamic imports and direct binding
access; it is not a safe deletion of the existing binding.
