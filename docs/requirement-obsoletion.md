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

## Database installation

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
