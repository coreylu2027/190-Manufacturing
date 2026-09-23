# Admin corrections to Onshape data

Approved admins can correct data delivered by the Onshape sync from the
**Correct Onshape data** section of the Production, Manufacturing, CAM, and
Finishing detail panels. Correctable values:

- part name, description, and material;
- the drawing PDF and STEP file;
- required quantity (also updates the finishing job's quantity);
- finishing color (None, Red, or Black), which creates, recolors, or retires the
  finishing job;
- routing OP1–OP4, with automatic CAM tasks for Haas/Shop Sabre stages; and
- **off-the-shelf**: the part is bought, not made.

Part details and files belong to the part, so they apply to every requirement
for that part. The rest belong to one production requirement. A new part
revision creates a new requirement, which starts again from Onshape.

Every saved correction posts an **Onshape data corrected** Slack alert with the
changes and optional reason. It adds a "check the routing and quantity" warning
when what the shop should make changed. The admin page lists every active
correction beside Onshape's value, with a CSV export for the CAD team.

## Persistence across syncs

Corrections are stored in `manufacturing.engineering_overrides` and
`manufacturing.attachment_overrides`; off-the-shelf is a requirement column that
the sync never writes. The sync is not modified: it still writes and validates
its own values. A trigger on `engineering_sync_runs` then runs in the same
transaction, before routing initialization and obsoletion, to:

1. record the value the sync just delivered as the field's Onshape value;
2. retire the correction if Onshape now delivers the same value; otherwise
3. restore the corrected value, re-activate or deactivate corrected routing
   stages, and keep the finishing job aligned; and
4. deactivate any routing or finishing the sync re-sent for off-the-shelf parts.

Retirement relies on the sync sending every managed field for each row it
stamps with `last_synced_at`, which the current sync does. Failed syncs do not
run the trigger. Replacement files and off-the-shelf status are never retired
automatically; revert them explicitly. Reverting a field restores the most
recent Onshape value.

## Off-the-shelf parts

Marking a part off-the-shelf retires its operations, CAM tasks, and finishing
job, so they leave the Manufacturing, CAM, QC, and Finishing queues. The
requirement stays in Production with an **Off the Shelf** status and filter,
and its retired routes remain visible. It is refused while any operation has
claimed or completed work, a CAM task is claimed, or finishing is claimed.
Unchecking it rebuilds the routing from the requirement's current (possibly
corrected) machines, reusing earlier rows and CAM work where still valid, and
re-plans readiness. Routing and finishing can't be edited while a part is off
the shelf, or in the same save as the switch.

Off-the-shelf parts have no QC review, so the existing On Robot rule (a passed
QC review is required) still prevents recording them On Robot. Shelf locations
work normally.

## Workflow safety

The application re-plans readiness with `planRequirementWorkflow`, like other
shop writes. Corrections are refused when they would discard or misattribute
work:

- a routing stage with claims, completions, or In Progress status cannot be
  changed or removed; nor can a claimed CAM task;
- switching between CNC machines after CAM is complete requires reopening CAM;
- pre-QC routing changes and quantity increases require undoing a passed QC;
- a quantity cannot drop below an operation's claimed-plus-completed total while
  claims remain; completed stages reopen or complete to match the new quantity;
- adding finishing is blocked after threaded-insert work starts or while the
  part is On Robot, and removing it is blocked while the job is claimed; and
- obsolete or inactive requirements accept only part-level corrections.

`public.manufacturing_apply_engineering_overrides` independently checks the
approved admin, write switch, request ID, manufacturing snapshot token, and a
separate override-state token. It limits changes to one requirement and its
part, allows engineering columns to change only through an override, refuses
reroutes that discard shop work, and verifies that routing and finishing rows
match the corrected requirement (or are all inactive for off-the-shelf parts)
before committing. Changed rows are recorded in `write_history`; every set,
revert, retirement, and off-the-shelf change is recorded in the append-only
`engineering_override_events`, with the optional reason.

## Replacement files

The browser uploads directly to a random `admin-uploads/` path in the private
`manufacturing-files` bucket with a signed URL, avoiding serverless body limits.
The server then checks the PDF or STEP structure, computes SHA-256, stores the
bytes at the same content-addressed path the sync uses (never overwriting), and
deletes the staging object. The attachment resolver and manifest prefer the
replacement. The bucket's configured size limit applies; the app allows up to
50 MB.

A replacement STEP never shows the synced part's 3D preview. Generate its own
offline, like synced previews:

```powershell
npm run manufacturing:generate-previews -- --apply --overrides-only
```

Without `--overrides-only`, the command processes synced and replacement STEPs
together. Replacement previews are stored in
`manufacturing.override_part_previews`, bound to the replacement's SHA-256. The
editor shows whether a replacement's preview is ready. Uploading a newer
replacement invalidates its preview until the command runs again.

## Installation

Apply `supabase/migrations/20260922190000_admin_engineering_overrides.sql` after
the engineering-sync API, routing initializer, obsoletion, visibility, and part
preview migrations. It adds tables, functions, one requirement column, and a
sync trigger; it does not modify existing manufacturing rows or enable writes.
Slack alerts use the existing `SLACK_WEBHOOK_URL`.

## Verification

- `npm run manufacturing:test-overrides` — PGlite; drives the real write adapter
  through a PostgREST-shaped fetch: survival across simulated syncs, retirement,
  failed syncs, revert, routing/CAM re-planning, off-the-shelf retire/restore,
  work and QC guards, finishing, CAS tokens, permissions, RPC allowlists,
  replacement files and previews, and the corrections report.
- `npm test` (includes the Slack alert format), `npm run manufacturing:test-migration`
  (includes the off-the-shelf projection), `npm run manufacturing:test-obsoletion`,
  `npm run lint`, and `npx tsc --noEmit`.
