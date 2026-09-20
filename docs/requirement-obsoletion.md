# Requirement obsoletion

Obsoletion is a reversible stop-work flag on one production requirement. It does
not replace manufacturing status, erase allocations, clear QC, move physical
parts, or transfer completion credit to a new revision. Approved users can mark
or restore requirements from Production details, with a version-checked Undo.

The existing PART cell displays the badge. Production includes an Obsolete
filter and retains deactivated routes for requirements with obsoletion history.
Restoring a historical requirement does not reactivate its BOM or routing.
Operations, CAM, finishing, QC decisions (including Force QC), and moves onto
the robot are blocked while obsolete. Notes and off-robot locations remain
editable. Profile renames leave obsolete work credit untouched.

Manual mark/restore actions, including both Undo directions, send notifications
through the existing Slack webhook after a successful change. Alerts identify
the actor, part, revision, assembly, and requirement. Obsolete alerts say not to
manufacture or install and flag parts recorded as On Robot. Restoration alerts
retain the distinction between removing obsoletion and satisfying workflow/QC/
routing requirements. Failed, stale, and unchanged requests do not send alerts.
Automatic database sync obsoletion does not use this application notification path.

## Stop-work alerts for claimants

Apply `supabase/migrations/20260919030147_obsolete_work_notifications.sql` after
the obsoletion and existing notification migrations. Each false-to-true obsolete
transition atomically inserts one `production_requirement_obsolete` notification
per user with remaining claimed manufacturing or CAM work. This includes manual
actions, Undo of restoration, and successful revision replacement. Deactivated
routing is included because sync deactivates it before marking the requirement
obsolete. Completed-only allocations do not notify. Legacy names resolve only
when exactly one profile matches; ambiguous or unmapped names are not guessed.

These records use the existing realtime subscription, unread queue, and
Acknowledge dialog, with the same styling as stolen-operation alerts. There is
no new UI. Repeated syncs and replacement-link updates on already-obsolete
requirements do not repeat stop-work alerts. Restoring does not dismiss an
unacknowledged alert; it remains a record of the stop-work event.

Manual actions initiate email delivery after the response. For sync-created
notifications, configure a Supabase Database Webhook:

1. Set a random server-only `NOTIFICATION_WEBHOOK_SECRET` on the app deployment.
2. Create an INSERT webhook on `public.notifications`, targeting
   `https://<app-origin>/api/notifications/deliver` with method POST.
3. Add `Authorization: Bearer <NOTIFICATION_WEBHOOK_SECRET>` and
   `Content-Type: application/json` headers. Use a timeout of 20000 ms.
4. Keep the existing `RESEND_API_KEY` and verified `NOTIFICATION_EMAIL_FROM`.

The endpoint loads recipient and content from the stored row, not the webhook
payload. Manual and webhook delivery share the existing Resend sender, HTML
escaping, delivery status fields, and notification-ID idempotency key. A webhook
can safely overlap manual delivery. Inbox delivery does not depend on email.
Email failures remain recorded for inspection; missing email configuration
leaves database-created alerts pending. Replaying the same INSERT payload retries
delivery within 23 hours. Older uncertain deliveries require manual review to
avoid resending after Resend's 24-hour idempotency window. Supabase webhooks do
not provide automatic retry here; monitor non-2xx webhook responses and failed/
pending `email_status` values. No production webhook or email test is created by
the migration itself.

## Database installation

### Admin visibility

`supabase/migrations/20260919223625_hide_obsolete_requirements.sql` adds reversible
requirement-level hiding. Approved admins can choose **Hide obsolete requirement**
in Production details, with Undo. Only obsolete requirements can be hidden.
The hidden requirement is omitted from normal Production, Manufacturing, CAM,
Finishing, and QC lists for everyone. Admins use **Show hidden** in Production to
find it and choose **Unhide requirement**, also with Undo. No table column is added.
Restoring from obsolete automatically unhides it. Neither hide nor unhide changes
manufacturing progress, quantities, QC, BOM membership, or routing.

The service-only visibility RPC independently checks the approved admin profile,
the manufacturing snapshot, and a separate visibility version. Writes are audited
in the existing write history; retries reuse the transaction request ID. Existing
requirement change triggers invalidate caches and broadcast realtime updates.
Hidden records remain in the internal projection and are available to admins;
this is a list visibility feature, not deletion or a new data confidentiality boundary.

Apply `supabase/migrations/20260918162451_requirement_obsoletion.sql` before
deploying the app changes. It depends on the normalized manufacturing schema,
production write and note RPCs, and the engineering-sync API/routing initializer.
It does not enable manufacturing writes, backfill historical obsoletion, or
change existing completion data. The existing requirements change trigger
provides realtime/cache invalidation; the app snapshot cache also has a new key.

The service-only `manufacturing_set_requirement_obsolete` RPC validates the
approved actor, write switch, snapshot token, and displayed obsoletion version.
Retries reuse a request UUID. The private append-only obsoletion history records
manual/automatic origin, actor, time, version, and replacement requirement;
manual changes additionally use the existing write-request audit trail.

`PUT /api/requirements/:id/obsoletion` accepts
`{ "obsolete": true, "expectedVersion": 0 }` and returns the requirement ID,
new obsolete flag, and new obsoletion version. Conflicts return HTTP 409 and
refresh the UI instead of applying an old Undo to a newer decision.

## Revision-sync contract

Apply `supabase/migrations/20260919222149_obsolete_removed_requirements.sql` to
also obsolete requirements made inactive by a successful sync when there is no
active requirement for the same part, assembly, source root, and configuration.
These confirmed removals have no replacement link. Existing history, work
guards, realtime claimant alerts, and email delivery apply unchanged. Already
obsolete requirements retain their existing obsoletion metadata and do not
notify again. Historical inactive records are not backfilled. Explicit restoration
survives unchanged syncs; reactivation followed by another removal is a new event.
Failed/partial syncs do not trigger removal obsoletion. An active but incomplete
or ambiguous replacement is not treated as a removal.

The engineering sync must reconcile requirements and update its run from
`running` to `success` in the same transaction, as with routing initialization.
The new hook runs after routing initialization. It matches an inactive old
requirement to exactly one active replacement by part, assembly, source root,
and configuration, with nonempty, different required part revisions. The
replacement must have initialized active operations and must not be obsolete.

Only requirements deactivated in that transaction, or previously linked to a
replacement, are candidates. Failed/partial runs and ambiguous or incomplete
replacements do not obsolete work. A manual restoration keeps its replacement
link, so an unchanged sync preserves the restoration and a later replacement
can obsolete the requirement again. Sync initialization skips manually stopped
requirements. There is no alphabetical comparison of revision names.

## Verification

- `npm test`
- `npm run manufacturing:test-migration`
- `npm run manufacturing:test-obsoletion` — isolated PostgreSQL via PGlite;
  permissions, retry/CAS, Undo, immutable work history, revision scope, repeated
  sync, restoration, and failed/partial/incomplete sync coverage.
- `npm run lint`, `npx tsc --noEmit`, and `npm run build`.

Browser verification uses synthetic records, covering production controls,
both Undo directions, badge refresh without a new column, historical details,
and disabled work/QC/finishing actions. No live manufacturing records are needed.
