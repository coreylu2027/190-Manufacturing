# Admin corrections to Onshape data

Approved admins can correct data delivered by the Onshape sync from the
**Correct Onshape data** section of the Production, Manufacturing, CAM, and
Finishing detail panels. Correctable values:

- part name, description, and material;
- the drawing PDF and STEP file;
- required quantity (also updates the finishing job's quantity);
- finishing color (None, Red, or Black), which creates, recolors, or retires the
  finishing job;
- routing OP1–OP4, with automatic CAM tasks for Haas/Shop Sabre stages;
- **when QC and finishing happen** (see below); and
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

## When QC and finishing happen

By default QC and finishing come after every operation except threaded
inserts, which follow them. **QC and finishing happen** can instead place them
after OP1–OP4: operations up to that point are inspected, and later ones wait
for the QC pass and any finishing. The editor previews the resulting order,
for example `OP1 Haas CNC → QC → Finishing (Black) → OP2 Tapping`.

The setting is stored in `requirements.qc_after_operation` (null is the
default), which the sync never writes, so it persists across syncs. It is
refused while QC is passed (undo the review first), for off-the-shelf parts,
for an operation the routing doesn't have, and when an operation that would
change sides of QC has claimed work. Completed work may move after QC. Each
change is recorded in `engineering_override_events` and shows in the part's
History.

Every rule that classified operations by the Threaded Insert machine now uses
the QC point: readiness planning, the QC and Finishing queues, claim guards,
Force QC, passed-QC quantity corrections, the On Robot guard, and routing
initialization after a sync (`manufacturing.is_post_qc_operation` mirrors
`isPostQcOperation`).

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
- pre-QC routing changes require undoing a passed QC;
- a quantity cannot drop below an operation's claimed-plus-completed total while
  claims remain; completed stages reopen or complete to match the new quantity;
- changing the quantity of a part that passed QC requires choosing what happened
  (see below);
- adding finishing is blocked after threaded-insert work starts or while the
  part is On Robot, and removing it is blocked while the job is claimed; and
- obsolete or inactive requirements accept only part-level corrections.

### Quantity changes after QC passed

The editor asks which of these happened:

- **QC approved the corrected quantity.** The records were wrong. Every pre-QC
  operation's completed count (and quantity ledger) is set to the new quantity
  and QC stays passed. Parts the records missed are credited to the correcting
  admin, like Force QC; removed parts come off the most recent credit first.
  Refused while a pre-QC operation has claims.
- **The original quantity was made.** Completed counts are kept. For a smaller
  quantity, QC stays passed and the extras are thrown away. For a larger one,
  every stage reopens for the extra parts, the QC outcome resets to Not
  Inspected, and post-QC work and finishing wait for the new review. Refused
  while the part is On Robot, finishing is claimed, or post-QC work is claimed.

`20260923040000_passed_qc_quantity_corrections.sql` lets the apply RPC rewrite
completed counts only alongside a quantity override on a passed part: pre-QC,
active, unclaimed manufacturing rows whose ledger totals match, ending Complete
at the corrected quantity. It keeps `operation_allocations` in step.

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

Apply `supabase/migrations/20260922190000_admin_engineering_overrides.sql`, then
`20260923040000_passed_qc_quantity_corrections.sql` and
`20260924000000_configurable_qc_point.sql`, after
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
