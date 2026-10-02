---
title: Installation plans
status: implemented
created: 2026-10-02
---

# Installation plans

## Contract

Installation administrators manage plan definitions and effective limits through
`void platform config plans` or the administration dashboard's Plans page. Existing built-in plan IDs, names, numeric defaults
and build container selection remain unchanged. Before an explicit default is
saved, hosted signup uses `free` and self-hosted signup uses `custom` as today.
Tenant application configuration cannot change installation policy.

Plans have stable IDs, editable display names, complete effective limits and an
archived state. Add a plan by copying an existing definition; editing changes
only supplied fields. Archiving prevents new assignments while existing accounts
continue using that plan. Removing an assigned plan requires an active replacement;
removing the default also selects its replacement. At least one active plan must
remain. Reset restores a built-in definition's original limits; custom plans have
no historical built-in defaults. Storage figures are informational and are not
presented as enforced configuration.

## Authority and application

Reuse the installation `platform_settings` record, operator authentication, audit
and dry-run conventions. Revision checks prevent a reviewed mutation from silently
applying to a newer configuration. Catalog locking serializes signup, assignment
and removal. All runtime consumers resolve limits from this same authority;
normal dispatch continues reading published routing rather than querying SQL.

Catalog mutations that change effective policy create bounded, durable propagation
progress. Retry incomplete propagation using `sync`; preserve its cursor until
quota evaluation and routing publication for each account complete. Block another
catalog mutation while the prior policy is pending. Ownership-sensitive publication
must reread the current owner behind the existing project fence.

Reevaluation preserves totals, billing periods, ownership history and administrator
suspensions. A lowered limit can immediately block further work already over quota;
preview describes that effect before application. Raising a limit removes only
matching quota blocks. Existing builds keep the timeout admitted at start. Updating
retention does not itself delete deployments. CPU policy preserves a project's
requested value when within the current ceiling. Settings updates require no
platform or tenant redeploy after the feature's initial installation upgrade.

When reconciliation precedes scheduled monthly rollover, counter initialization
performs the normal rollover cleanup before advancing its billing period. It never
relabels prior-period usage as current. Delayed initialization and scheduler
snapshots cannot rewind the ledger or clear current-period totals. Administrator
suspensions remain intact.

## Accounting upgrade

The previous consumer skipped UsageCounter records for unlimited request plans;
analytics and error alerts still ran. Forward all valid authenticated events to
owner counters so dynamic unlimited/capped policies retain recorded requests and
sandbox intervals across transitions. Do not backfill the counter from delayed
Analytics results: overlapping queued events and incomplete retained ownership
history cannot establish an exact deduplicated baseline. Existing unlimited
accounts may therefore lack pre-upgrade requests in their current-period quota
counter. Document that actionable first-upgrade limit-setting boundary and warn
when an operator introduces a request cap. Historical analytics are preserved.

## Runtime rollout

Production and staging catalog writes and propagation wait 15 minutes after the
current API version upload, matching the existing ownership-transfer rollout
boundary. Reads and previews remain available during this interval. All API and
Durable Object readers must be upgraded before configuring a dynamic catalog.
Version metadata guards the normal upload-and-activate workflow; it does not
establish safety for activating retained older versions or a gradual rollout.
Before reverting to a runtime without catalog support, restore built-in limits,
build sizes, permissions and signup defaults, and move custom-plan assignments to
built-in IDs. Preserve usage totals during this preparation.

## Implementation and verification

The validated contract lives in `@void/platform/plans`. The API resolves the saved
catalog from platform settings, while the operator API reuses administrator
sessions and audit events. The CLI previews each change, applies its exact
revision, and continues bounded account updates until completion or a retryable
failure. Build size and timeout are captured when a build is admitted; token
refresh respects that admitted deadline.

The administrator dashboard uses the same catalog mutations, revision checks,
rollout guard, and audit records. Native forms review a change before applying
its exact revision. A result page advances the saved cursor in bounded batches,
stops on errors or lack of progress, and exposes a resumable action in Plans.
Fate reads the catalog and account counts through the lightweight shared reader;
its browser generation does not import deployment or Sandbox mutation code.
Removal previews compare the departing plan with its replacement's limits,
build size, and short-slug permission in both the CLI and dashboard.

Deploy cutover and compensation resolve current owner policy behind project
fences. A policy update cannot publish stale limits after reconciliation or make
a failed candidate look like a newer deployment and prevent routing restoration.
Mutable policy is refreshed without replacing the committed Worker or static
deployment identity.

Regression coverage includes authorization, stale previews, invalid values,
add/rename/archive/restore/remove/default/reset, signup defaults, concurrent
assignment/removal, quota preservation, capped/unlimited transitions, ownership
transfer, active/custom-domain/email routing, interrupted sync, and running/new
build behavior. Actual UsageCounter instances verify preservation of the billing
ledger, and a built CLI subprocess exercises the operator API end to end.

Focused regressions, affected selection, workspace typechecking, formatting,
lint, and documentation rendering passed. The final full suite passed 660 files:
12,321 tests passed and 25 skipped.

Dashboard coverage verifies administrator access, same-origin forms, private
headers, read-only previews, stale revisions, invalid limits, catalog management,
replacement assignments, retryable propagation, Fate path validation, and the
built browser's navigation and automatic continuation across account batches.
The native form fixture reads the action attribute because a named `action`
input shadows the DOM property, and reports validation failures directly.

Dashboard verification passed 17 focused tests, 193 affected files (3,842 tests),
workspace typechecking, lint, formatting, runtime builds and documentation builds.
The final full run passed 661 files and 12,329 tests with 25 skipped, but exited
with an unhandled Node `setTypeOfService EINVAL` socket error during the Solid
playground suite. Its isolated rerun passed all 26 tests without that error.
The upgraded e2e installation passed browser catalog, edit, preview and cancel
checks without browser errors or changes to its catalog and application pointers.

Follow-up review reproduced and fixed billing-period relabeling during plan
reconciliation and missing replacement policy details in removal previews.
Regressions use the production counter and actual operator/admin handlers.
Workspace typechecking, lint, formatting, documentation rendering and the final
full suite passed: 661 files, 12,334 tests passed and 25 skipped, with a clean exit.
