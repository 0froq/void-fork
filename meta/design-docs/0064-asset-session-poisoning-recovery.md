---
title: WfP Asset-Session Poisoning — Control Flow and Recovery Layers
status: implemented
created: 2026-04-22
---

# WfP Asset-Session Poisoning — Control Flow and Recovery Layers

## Summary

Cloudflare's WfP `/assets-upload-session` endpoint (tracked upstream in `cloudflare/workers-sdk#12586`, internal **WC-4511**) intermittently claims asset hashes are already cached when the backing bytes are not actually present. Workers deployed against a poisoned session ship successfully but serve a 36-byte stub (`Assets have not yet been deployed to this script.`) for the affected paths. This document describes the control flow, every defense layer added over time, and what remains unrecoverable.

## Background: how WfP asset uploads work

WfP assets use a three-step handshake:

1. `POST /accounts/:id/workers/dispatch/namespaces/:ns/scripts/:script/assets-upload-session` — send the asset manifest `{path: {hash, size}}`; Cloudflare returns a completion JWT and **buckets** (the hashes it wants uploaded). Any hash in the manifest but absent from the buckets is CF claiming "already uploaded".
2. `POST /assets-upload` per bucket — upload the bytes grouped into the JWT-signed bucket.
3. Attach the completion JWT to the worker script metadata when uploading the script.

CF dedupes across sessions per-account. Under WC-4511, CF's dedupe index has entries without the bytes behind them. The worker upload succeeds, the worker goes live, and subsequent GETs for those paths return the 36-byte stub.

## Timeline of defenses

### Layer 1 — Novel-hash injection (`29e567e`, 2026-04-20)

Before calling `createAssetUploadSession`, inject `/.void-deploy/<deploymentId>.txt` with a `${deployId}\n${Date.now()}\n` payload. This guarantees at least one manifest entry CF has never seen, which forces CF to actually process the manifest instead of returning a cached plain-text "Assets have already been uploaded" short-circuit.

- Code: `packages/api/src/routes/deploy.ts:1843-1857`.
- **Limit:** does not "unpoison" pre-existing bad dedupe entries. Only guarantees CF returns a valid JSON session response for this request.

### Layer 2 — Per-project corroboration refusal (`29e567e`)

If CF's session response omits a hash the local blob map still has bytes for, check whether any prior deployment of **this project** already recorded that hash in its `asset_hashes` column on the same backend. If yes, trust the omission (CF really has those bytes). If no, refuse pre-upload.

- Code: `packages/api/src/routes/deploy.ts:680-693` (helper), guard originally at `deploy.ts:2122-2148`.
- **Limit:** per-project scoping was over-restrictive — WC-4511 is an account-level cache, and many legitimate hashes are shared across projects on the same CF account (Vite runtime, framework bundles).

### Prior fix — Early `asset_hashes` persistence (PR #102, `32933ef`, 2026-04-21)

Before PR #102, `asset_hashes` was written only after migrations succeeded. A first deploy that passed asset upload but failed at migrations left the row empty, so retries could never corroborate — the project was permanently deadlocked. PR #102 moved the write to run **immediately after `uploadAssetBuckets` succeeds**, plus added `deploymentBackendKindFromManifest` so SPA/static rows cannot vouch for WfP deploys (KV/R2 bytes live in a different store than CF's WfP cache).

- Code: `deploy.ts:2326-2336` (persist), `deploy.ts:644-677` (backend classifier).
- **Limit:** solved retry deadlock for projects with one prior successful WfP upload, but left fresh projects and static→server migrations with no WfP baseline to corroborate.

### This fix — Platform-wide corroboration + salt-on-collision (`c15dfa0`, 2026-04-22)

Two additions, driven by observed prod incidents (`source-map-viewer`, `dpl_49ehj42935ji` / `dpl_cda6upl0laud` / `dpl_sxt86xioqvr8`). A fresh project had 18 common Vite/Vue/Shiki/UnoCSS chunks blocked on every attempt because per-project corroboration was empty.

#### Layer 3 — Platform-wide corroboration

Widen the corroboration scope to every WfP deployment on the account. Any prior successful WfP upload of a given hash — regardless of which project uploaded it — is sufficient evidence CF holds the bytes, because WC-4511 is per-account.

- Code: `packages/api/src/db.ts:698-718` (`getPlatformDeploymentsWithAssetHashes`, `PLATFORM_ASSET_HASH_CORROBORATION_LIMIT = 500`), `packages/api/src/routes/deploy.ts:695-711` (`getPlatformCorroboratedWfpAssetHashes`).
- **Covers:** shared cross-project chunks (Vite runtime, preload-helper, popular framework bundles). In prod, Vite's preload-helper hash (`1d96191c9411b27647107ed9813508f4`) is already present in 126 WfP deployments — platform-wide corroboration short-circuits salting for it.
- **Does not cover:** project-specific hashes that have never been successfully uploaded by any project on the platform. For those, Layer 4 runs.

#### Layer 4 — Salt-on-collision retry

For hashes neither per-project nor platform-wide corroboration vouches for, bypass CF's poisoned dedupe entry by changing the hash. Prepend a deterministic marker comment to the asset bytes (`/* __void:<deployId> */` for JS/CSS, `# __void:<deployId>` for `text/plain`), recompute `computeAssetHash`, rewrite every manifest path that referenced the old hash, and re-issue `createAssetUploadSession` with the rewritten manifest. CF has never seen the salted hash, so it requests the bytes on the retry and the poisoned entry is bypassed.

- Code: `deploy.ts:731-753` (`saltBytesForContentType` — the safe content-type allowlist), `deploy.ts:763-820` (`saltUncorroboratedAssets` — in-place rewrite of `assetManifest` and `assetsByHash`), `deploy.ts:2310-2360` (retry session + salted-hash verification).
- **Saltable content types:** `text/javascript`, `application/javascript`, `text/css`. These are the only MIMEs where `/* marker */` is universally parser-inert.
- **Unsaltable content types:** JSON (no comment syntax), HTML (a leading comment before `<!DOCTYPE>` triggers quirks mode), SVG/XML (prolog must stay first), `text/plain` (catch-all MIME — `#` is a comment in robots.txt but a literal character in sitemap.txt, a field value in CSVs, a non-leading literal in `.properties`, and an H1 in Markdown-as-text/plain; no safe prefix exists), and all binary formats (images, fonts, wasm). These fall through to the hard refusal with a clearer error message that names "cannot be salted".
- **Retry-still-omits escape:** the retry session is a fresh roll of CF's dedupe and may omit hashes that the first session included in its buckets — not just the salted ones. After the retry, re-run the full omission → corroboration check against the retry response (reusing the per-project and platform-wide sets already fetched). Refuse if any retry omission is uncorroborated. A salted hash in retry omissions is necessarily uncorroborated (fresh bytes CF has never seen), which means CF's dedupe is poisoned even for brand-new content and we cannot bypass it from the client side.

## The full recovery cascade

```
┌─ Buffer assets → build manifest + assetsByHash map
│
├─ Layer 1: inject /.void-deploy/<id>.txt (force CF to re-validate session)
│
├─ createAssetUploadSession()  ◄─────────────────────────────┐
│                                                             │
├─ omittedBufferedHashes = (local blobs) − (session buckets)  │
│                                                             │
├─ if omitted:                                                │
│    ├─ Layer 2: remove hashes covered by per-project WfP     │
│    │           corroboration (LIMIT 100)                    │
│    ├─ Layer 3: remove hashes covered by platform-wide WfP   │
│    │           corroboration (LIMIT 500)                    │
│    │                                                        │
│    ├─ if still uncorroborated:                              │
│    │    ├─ Layer 4a: saltUncorroboratedAssets()             │
│    │    │    ├─ rewrites: text → new hash (mutate manifest) │
│    │    │    └─ unsaltable: binary → REFUSE (hard)          │
│    │    │                                                   │
│    │    └─ Layer 4b: createAssetUploadSession() ────────────┘ (retry once)
│    │                  re-run omission → corroboration check;
│    │                  any uncorroborated retry omission → REFUSE
│    │
│    └─ (all omissions accounted for — CF has the bytes)
│
├─ uploadAssetBuckets() — upload the bytes CF asked for
├─ persist asset_hashes (PR #102 — survives downstream failures)
└─ upload worker → go live
```

## What is still irrecoverable (by design)

| Scenario                                            | Behavior                                                 | Why                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binary/unsaltable uncorroborated hash               | Hard refuse, error names the hash and "cannot be salted" | No safe way to mutate content to change the hash for binary formats.                                                                                                                                                                                                                                                                                                         |
| Salt-retry session omits any uncorroborated hash    | Hard refuse, error says "still omits"                    | CF's dedupe selection changed between session 1 and the retry. A retry omission that is neither in the per-project nor platform-wide corroboration set cannot be trusted — either CF dropped a hash that session 1 would have uploaded, or a freshly-salted hash is still being deduped (meaning CF is poisoned even for bytes it has never seen). Operator action required. |
| All recovery passes but CF evicts bytes post-deploy | Not handled                                              | Would require post-deploy probing; deferred (see [Alternatives considered](#alternatives-considered)).                                                                                                                                                                                                                                                                       |

## Invariants preserved across all layers

- **Cross-backend safety.** SPA/static rows never vouch for WfP deploys. PR #102's `deploymentBackendKindFromManifest` filter runs in both per-project and platform-wide helpers. Salt-on-collision is the mechanism that lets a static→server migration proceed without violating this invariant.
- **Bounded memory.** Per-project query is capped at `ASSET_HASH_CORROBORATION_LIMIT = 100`; platform-wide at `PLATFORM_ASSET_HASH_CORROBORATION_LIMIT = 500`. Combined worst-case ~18 MiB of JSON parsed into a `Set<string>` — fits the 128 MiB Worker isolate budget even on active CI/CD platforms. Lesson 30.
- **`asset_hashes` reflects reality.** Salted rewrites mutate `assetManifest` in place; the persisted row contains the salted hashes (what CF actually stored), so the next deploy's corroboration matches CF's state.
- **Refusal before upload.** The hard refusal paths throw before `uploadAssetBuckets` runs, so no worker script is ever shipped referencing a hash CF might serve as a stub. The session JWT for a refused attempt is simply abandoned.
- **Layer 1 stays on for every WfP deploy.** Novel-hash injection is independent of the recovery cascade — it guards against CF returning cached plain-text responses instead of a proper session.

## Alternatives considered

- **Remove the guard entirely.** The WC-4511 stub-serving incident is observed, not theoretical. Removing the guard would ship broken deploys with no signal until user traffic hit the stubs.
- **Post-deploy stub verification.** Fetch a sample of uncorroborated paths from the live worker; if any returns the 36-byte stub, roll back. More invasive (needs a staged-deploy state or retroactive rollback) and can't unstick a project if CF is persistently poisoned. Deferred — the three-layer recovery addresses every observed production case.
- **Escape-hatch CLI flag `--allow-omitted-hashes`.** Small diff, immediate unblock, but shifts the risk onto every user who hits this and doesn't scale past individual incidents. Not needed once salt-on-collision is in place.
- **Schema change: `known_asset_hashes(hash PRIMARY KEY)` lookup table.** Cleaner platform-wide corroboration with O(log n) queries and no LIMIT cutoff. Deferred — the bounded JSON scan is sufficient for current load, and a migration + backfill is disproportionate to the incident rate.

## Observability

- Console log: `[deploy] <projectId>: salted <N> asset(s) to bypass CF dedupe poisoning, re-issuing session` fires whenever Layer 4 engages. A spike indicates CF's dedupe is actively poisoned for the account.
- Deploy error messages distinguish the three irrecoverable paths: `"cannot corroborate"` (pure refusal, pre-salt), `"cannot be salted"` (unsaltable content), `"still omits"` (retry failed).
- Persisted `deployments.asset_hashes` shows salted hashes on affected rows — grep across the table surfaces historical occurrences for audits.

## Code map

| Concern                                        | File:line                                                    |
| ---------------------------------------------- | ------------------------------------------------------------ |
| WC-4511 upstream reference                     | `packages/api/src/routes/deploy.ts:1834-1842`                |
| Layer 1 — novel-hash injection                 | `deploy.ts:1843-1857`                                        |
| Layer 2 — per-project corroboration            | `deploy.ts:680-693`, `packages/api/src/db.ts:686-696`        |
| Layer 3 — platform-wide corroboration          | `deploy.ts:695-711`, `db.ts:698-718`                         |
| Backend-kind classifier (cross-backend safety) | `deploy.ts:644-677`                                          |
| Layer 4a — salt content-type policy            | `deploy.ts:731-753`                                          |
| Layer 4a — salt rewrite                        | `deploy.ts:763-820`                                          |
| Layer 4b — retry session + still-omits check   | `deploy.ts:2310-2360`                                        |
| Full guard cascade                             | `deploy.ts:2283-2360`                                        |
| `asset_hashes` early persistence (PR #102)     | `deploy.ts:2326-2336`                                        |
| Integration tests                              | `packages/api/test/integration/api-deploy.test.ts:1128-1645` |

## References

- Upstream tracking: [`cloudflare/workers-sdk#12586`](https://github.com/cloudflare/workers-sdk/issues/12586)
- Internal ticket: **WC-4511**
- Original defense commit: `29e567e` — `fix(api): work around CF assets-upload-session dedupe poisoning`
- Early-persist fix: `32933ef` (PR #102) — `fix(api): unblock post-migration-failure deploys via early asset_hashes persistence`
- This fix: `c15dfa0` — `fix(api): recover fresh-project WfP deploys from CF asset-session poisoning`
- Observed prod incident: project `source-map-viewer` (`proj_pdszrn3030tp`), failed deploys `dpl_49ehj42935ji`, `dpl_cda6upl0laud`, `dpl_sxt86xioqvr8` on 2026-04-21.
