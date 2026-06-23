---
title: Decouple GitHub-for-Deploys from Login Provider (First-Class Identity Linking)
status: proposed
created: 2026-06-23
---

# RFC: Decouple GitHub-for-Deploys from the Login Provider

## Summary

A Void user who signed up with **Google** (or any non-GitHub provider) currently cannot use Deploy-on-GitHub. `GET /github/install-url` returns **403** unless the caller already has a linked GitHub OAuth identity (`getCallerGitHubAccountId !== null`, `github.ts:131-134`). The only way to get that identity today is to **log in with GitHub** — which, if the GitHub primary email differs from the account email (or is unverified), creates a **separate Void user** instead of linking (`auth.ts:321-342`). So the practical state is: _Google users can't deploy on GitHub without risking an account fork._

This RFC makes obtaining a GitHub identity a **first-class, authenticated linking action that is independent of how you log in** — the Vercel "connect your Git provider" model. `void github install` auto-runs the link when the caller has no GitHub identity, then the **existing, audited install/connect flow runs unchanged**. The security-sensitive public callback (`/github/callback`) and its confused-deputy protections are **not touched**.

## Background

Two facts, both verified in source:

1. **The install gate is real and load-bearing.** `install-url` embeds `{userId, githubAccountId}` into HMAC-signed `state`. The public `/callback` uses `githubAccountId` to prove — against GitHub — that the person completing the install is the same GitHub account that initiated it (`github.ts:262-279`). This closes a confused-deputy hole: without it, an attacker could phish a victim into installing the App and have the victim's installation (and private repos) bound to the attacker's Void account.

2. **The only path to a GitHub identity is login.** `oauth_accounts(provider='github')` rows are created only in the OAuth login callback. For a user already logged in via Google, the sole way to add a GitHub row is to log in via GitHub, which links **only if** the GitHub primary email is verified **and** matches the existing account email — otherwise it forks a new user (`auth.ts:321-342`). There is **no** "link my GitHub account to my current account" action.

### Comparison: how Vercel handles this

| Axis                     | Vercel                                                                                                                | Implication for Void                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Login identity ↔ account | **1:1** (one GitHub login → one Vercel account)                                                                       | Void's 1:1 is not an outlier; not the thing to fix                                                          |
| Git-for-deploys ↔ login  | **Decoupled** — "connect to other GitHub accounts/orgs from a Vercel account or Team" regardless of how you signed in | **This is the lever.** Void should let any authenticated user connect GitHub, independent of login provider |

Sources: [How to connect a single GitHub account to multiple Vercel accounts](https://community.vercel.com/t/how-to-connect-a-single-github-account-to-multiple-vercel-accounts/37062), [Vercel KB: connecting teams with personal Git accounts](https://vercel.com/kb/guide/connecting-teams-with-personal-git-accounts).

## The root constraint (why we can't just remove the gate)

To bind a GitHub App installation to a Void user, the platform **must** prove that user controls the GitHub account that owns the installation. This is not incidental — it is the entire anti-confused-deputy guarantee. Therefore a GitHub identity **must** be established for the user. The design question is only **when and how** that identity is obtained — **not whether**.

The naive "drop the 403 and bind by `state.userId` alone" reopens the hole:

```
attacker A (no GitHub identity)
  → install-url → state{userId:A}            (no githubAccountId ⇒ no continuity anchor)
  → A sends URL to victim B
  → B installs the App on B's org + authorizes → code_B
  → callback: authorizeInstallViaUserToken(code_B) → caller=B, ids.has(X)=true → authorized
            continuity check (caller == state.githubAccountId) is skipped — nothing to compare
  → installation X (B's repos) bound to A's Void account → A reads B's private repos
```

This is **rejected** (see Alternatives). The continuity check (`github.ts:270`) is exactly what blocks it today.

## Goals / Non-Goals

**Goals**

- Any authenticated Void user (Google, GitHub, future SSO) can use Deploy-on-GitHub.
- Linking GitHub to an existing account **never forks** the account.
- The audited install/connect/callback security model is **preserved unchanged**.
- `void github install` is seamless: it links on demand, then installs.

**Non-Goals**

- Changing the login model or the 1:1 login↔account relationship.
- Allowing one GitHub org to map to multiple Void accounts (mirrors Vercel's unsolved case; out of scope).
- Reworking the public `/callback` ownership proof.
- Closing the pre-existing org-install `read:org` confused-deputy edge ([[project_github_org_install_ownership]]) — tracked separately.

## Design

Add a **first-class, authenticated GitHub-identity link**, decoupled from login, and wire `void github install` to use it.

### 1. Platform — link helper (DB)

`linkGitHubIdentity(db, userId, providerId, login)` in `db.ts`:

- Insert `oauth_accounts(user_id, provider='github', provider_id, ...)` for `userId`.
- **Conflict backstop:** if `provider_id` is already linked to a **different** user, reject (`409`, "this GitHub account is already linked to another Void account"). Mirrors the install backstop (`github.ts:284-287`).
- Idempotent: if already linked to the same user, no-op success.

### 2. Platform — authenticated link flow (three routes, mirrors `void auth login`)

The bind to a user **must not** happen in the public callback against `state.userId` — that reopens an account-linking CSRF (see Security analysis, threat L1). Instead the flow mirrors the existing CLI login: the GitHub result is held as a one-time, PKCE-bound code that is delivered to the **initiator's localhost**, then redeemed by an **authenticated** call that binds to the **token-holder** (not `state.userId`).

- `GET /github/link-url` (**authMiddleware**) → mint a GitHub App **user-OAuth authorize** URL (`https://github.com/login/oauth/authorize?client_id=<GITHUB_APP_CLIENT_ID>&redirect_uri=<API>/github/link-callback&state=…`) with HMAC-signed `state{redirect, purpose:'link', codeChallenge, codeChallengeMethod, exp}`. `redirect` must be a localhost callback (reuse `isLocalhostRedirect`). Fails closed with a clear message when `isAppUserOAuthConfigured(env)` is false. **No `userId` in state** — the bind happens at completion.
- `GET /github/link-callback` (**public, signed-state**) → verify HMAC + `purpose:'link'` + `exp`; exchange `code` → `providerId` via a new exported helper in `github/user-installations.ts` (wraps the existing internal `exchangeInstallCodeForUserToken` → `fetchUserAccountId`; **no installationId** — pure identity); mint a **stateless HMAC-signed `link_code`** embedding `{providerId, codeChallenge, codeChallengeMethod, exp}`; redirect to `state.redirect` (localhost) with `?link_code=…`. **It does not link anything.** Same HMAC-state trust model as `/callback`; no session cookie, no DB row.
- `POST /github/link/complete` (**authMiddleware**) → body `{link_code, code_verifier}`; verify the `link_code` HMAC + `exp`, then PKCE (`isValidCodeVerifier(verifier)` && `createCodeChallenge(verifier) === embedded codeChallenge` && method match), then `linkGitHubIdentity(db, context.get('user').id, providerId)`. Returns `{status:'linked'|'already_linked'}` or **409** on `GitHubIdentityConflictError`.

The PKCE primitives (`createCodeChallenge`, `isValidCodeVerifier`, `CLI_CODE_CHALLENGE_METHOD`) currently live module-private in `routes/auth.ts`; extract them to `src/auth/pkce.ts` (pure, no behavior change) so both `auth.ts` and `github.ts` import them.

The link proves the **current** authenticated token-holder controls a GitHub account, and attaches it to **that** user*id — so no email-matching and **no fork**. Because the result lands on the initiator's own localhost and the bind keys on the token-holder, an attacker can only ever link their \_own* GitHub.

### 3. Platform — install-url (unchanged gate, better signal)

`/install-url` keeps requiring a GitHub identity (security unchanged). Its 403 body becomes a stable, machine-recognizable code (e.g. `{ error: 'github_identity_required' }`) so the CLI can react precisely instead of string-matching.

### 4. CLI — `void github link` + auto-link in `install`

- New `void github link`: mirrors `runLogin`'s localhost + PKCE scaffold (`auth.ts`). Generate a `code_verifier`/`code_challenge`, start the localhost server, call authed `GET /github/link-url?redirect=<localhost>&code_challenge=…`, open the returned authorize URL, receive `?link_code=…` on localhost, then call authed `POST /github/link/complete {link_code, code_verifier}`. Bound to the **current token's user**. Reports "GitHub account linked." / "GitHub already linked." / on 409 "this GitHub account is already linked to another Void account."
- `runInstall` (`github-cmd.ts:117-135`): on `github_identity_required`, **auto-run the link flow, then retry** `install-url` once. If linking is declined/fails, print actionable guidance (`void github link`). The current message ("Run `void auth login` and choose GitHub") is removed — it is misleading and risks the fork.

### 5. Docs

Update `docs/reference/cli.md` (github section): document `void github link`, and that Deploy-on-GitHub works from any login provider after a one-time GitHub link.

### What does NOT change

`/github/callback`, `authorizeInstallViaUserToken`, the continuity check, the cross-user backstop, `getGitHubInstallationsByUser`, and `POST /projects/:id/github` (connect) — all untouched. Install/connect still gate on `github_installations.user_id`, which is set from the signed `state.userId` exactly as today.

## Security analysis

- **Confused-deputy (install):** unchanged. Install still requires `state.githubAccountId`, and `/callback` still enforces continuity (`caller == state.githubAccountId`). Linking only _populates_ `githubAccountId` for the user; it does not weaken the install proof.
- **Threat L1 — account-linking CSRF (the reason for the 3-route design).** If the public `link-callback` bound directly to `state.userId`, attacker A could mint a link-url, phish victim B into authorizing with B's GitHub, and bind B's GitHub identity to A's account (bounded by the conflict backstop to not-yet-linked ids; no repo access, since install still needs the continuity proof — but a real identity-integrity/DoS bug). Closed by deferring the bind: the GitHub result is delivered as a PKCE-bound one-time `link_code` to the **initiator's localhost**, and `POST /github/link/complete` binds it to the **authenticated token-holder**, never `state.userId`. The result lands on the completer's own machine and authorizes with the completer's own GitHub, so an attacker can only ever link their own identity.
- **Link-code integrity:** the `link_code` is an HMAC-signed, short-`exp`, PKCE-bound blob (stateless — no DB row). It is **inert without the `code_verifier`**, which never appears in any URL or redirect (only in the CLI process, sent once over TLS to `/complete`). Non-single-use is acceptable: replay by the same user is an idempotent `already_linked`; replay binding the id to a _different_ user is blocked by the `(provider, provider_id)` unique index (→ `GitHubIdentityConflictError`/409). So the unique index — not a single-use DB row — is the authority that an id maps to exactly one account.
- **Link-flow integrity:** `link-callback` is HMAC-state-authenticated (same model as `/callback`); the conflict backstop (`GitHubIdentityConflictError` → 409) prevents stealing a GitHub identity already owned by another Void user. The code-exchange proves the linker controls the GitHub account.
- **No new GitHub App dependency for the common case:** unlike the rejected decoupling, this design does **not** require "Request user authorization (OAuth) during installation" to be ON. The existing install flow still works via the account-id fallback for personal installs; that setting remains relevant only for org installs (pre-existing behavior).

## Alternatives considered (rejected)

- **A1 — Drop the 403, bind by `state.userId` only.** Reopens the confused-deputy attack above. Rejected.
- **A2 — Authenticated "claim" / polling model** (callback records a pending install; CLI claims it authenticated). Still cannot bind without proving GitHub-account control, so it needs the same identity step — more moving parts, new pending-install state, no security gain over linking. Rejected.
- **A3 — Rely on login-time email-match linking** (`auth.ts:321-342`). Already exists but forks the account when emails differ/unverified, and forces "log in with GitHub." This RFC keeps it as a convenience but it is not the canonical path. Insufficient alone.
- **A4 — Two-route link: public `link-callback` binds directly to `state.userId`.** Simpler (no third endpoint, no GitHub App callback change), but opens the account-linking CSRF in threat L1. Rejected in favor of the deferred-bind 3-route flow.
- **A5 — Reuse the login flow (`/auth/login?link=1` + branch `/auth/callback` + `/auth/cli/link`).** Reuses cookie-nonce/PKCE/code-storage and the already-registered callback (no GitHub App change), and is equally secure. Rejected only for **blast radius**: it edits the audited login path, which this RFC's non-goals keep untouched. The 3-route GitHub-side flow keeps `/auth/*` and `/github/callback` fully isolated.

## Implementation plan (SDD tasks)

Global constraints for all tasks: preserve the `/github/callback` security model untouched; the conflict backstop on linking is mandatory; `github_identity_required` is the stable 403 code contract between server and CLI.

1. **DB link helper** — `linkGitHubIdentity` + conflict backstop in `db.ts`; unit tests (new link, idempotent re-link, conflict→reject). _(api)_
2. **Link routes (3 endpoints, deferred bind)** — extract PKCE primitives to `auth/pkce.ts`; add exported identity-from-code helper in `github/user-installations.ts`; `GET /github/link-url` (authed, localhost redirect + PKCE challenge + `exp` in signed state) + `GET /github/link-callback` (public, signed-state, `purpose:'link'`, mints **stateless HMAC-signed PKCE-bound `link_code`**, no bind) + `POST /github/link/complete` (authed, verifies link*code HMAC+`exp`+PKCE, binds to token-holder via `linkGitHubIdentity`, 409 on conflict); integration tests (happy path links to **current token's user**; forged/altered state reject; non-localhost redirect reject; expired state/link_code reject; PKCE-verifier mismatch reject; conflict→409; \*\*threat-L1 regression: a link_code completed under a \_different* token binds to that token-holder, not to any state.userId\*\*; OAuth-not-configured fails closed). _(api)_
3. **install-url 403 contract** — return `{ error: 'github_identity_required' }`; test the code is stable and still 403s with no identity. _(api)_
4. **CLI `void github link`** — args + cmd + client method + localhost-callback wiring bound to current user; unit tests (arg parse, success/decline/conflict messaging). _(framework)_
5. **CLI `runInstall` auto-link** — detect `github_identity_required` → run link → retry once; remove the misleading message; unit tests. _(framework)_
6. **Docs** — `docs/reference/cli.md` github section: `void github link` + "deploy from any login provider." _(framework)_

Verification: `vp run check` (platform) + `vp run --filter ./packages/void typecheck` (framework); targeted tests per task; full `vp test run` at the end (both repos).

## Operational note

No new env vars. Reuses existing GitHub OAuth client (`GITHUB_APP_CLIENT_ID`/`SECRET`). If those are unset, `void github link` fails closed with a clear "GitHub linking not configured" message — same posture as the existing user-auth-on-install path.

**One owner action (deploy prerequisite):** the 3-route flow uses a new `redirect_uri = <API>/github/link-callback`, so `/github/link-callback` must be added to the GitHub App's **Callback URL** list (it already lists `/github/callback` for install). Add it for staging and prod App configs before the feature goes live. No code/env change.
