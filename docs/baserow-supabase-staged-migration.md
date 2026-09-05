# Baserow to Supabase: staged migration

> This is the historical staging report. Its production-write implementation
> gate has since been completed; see
> [Supabase production writes](supabase-production-writes.md). A live cutover is
> still separate from the implementation.
> The 241 attachment binaries described below were subsequently copied to private
> Supabase Storage and independently verified; the original statement is retained
> as the historical condition at staging time.

## Completed stage — September 4, 2026 (America/New_York)

The active `V3-26 FRC190 Summer 2026` database (`515011`) was copied into
`frc190_baserow_stage` in the existing `frc190-manufacturing` Supabase project
(`ltyvookdgibzicplghte`). **No application cutover or deployment was performed.**
The existing environment variables, Supabase project configuration, public
tables, Auth accounts, and Storage were left in place.

The snapshot is `a594833a-f7b3-402f-9949-232d1a1f7b47`, captured at
`2026-09-05T00:13:03.216Z` and staged at `2026-09-05T00:18:37.508254Z`.

| Table | Original table ID | Rows |
| --- | ---: | ---: |
| Production Requirements | 1119642 | 232 |
| Assemblies | 1119645 | 12 |
| Parts | 1119641 | 228 |
| Operations | 1169282 | 388 |
| Sync Runs | 1119639 | 236 |
| Finishing | 1170619 | 45 |
| **Total** | | **1,141** |

App Users (`1126322`) and Storage Locations (`1119643`) were explicitly excluded
at the user's request. The exporter does not request their schemas or rows.
Links to those tables, if present, are retained as external IDs and are not
represented as verified internal relationships. This snapshot has none.
Existing **Supabase profiles are preserved**; they are separate from the
excluded Baserow App Users table.

Validation established:

- Two complete Baserow reads matched before import; another two matched after
  import, through `2026-09-05T00:20:14.856Z`.
- All source field schemas, 1,141 raw rows, and 1,326 ordered links matched the
  staged data using bidirectional SQL comparisons and database foreign keys.
- The document read back from Supabase matched the local SHA-256 digest.
- Original IDs, select option metadata, row order values, nulls, timestamp
  strings and precision, active/inactive flags, and every raw field were kept.
- All 49 quantity ledger strings were retained verbatim. Stored claimed and
  completed quantities total 13 and 29 respectively. No ledger inconsistencies
  or missing non-legacy claimant profiles were found.
- All eight existing QC reviews resolve to included production requirements.
  QC rows were not rewritten, backfilled, deduplicated, or deleted. Their
  reviewer IDs, notes, dates, historical operation IDs, and requirement IDs
  remain in the existing authoritative table and in the private baseline.
- Existing 27 Auth accounts, 27 profiles, three notifications, eight QC records,
  public schema/permissions/policies/functions/indexes, Auth/public triggers,
  and empty Storage matched before/after fingerprints at the audit checkpoints.
- A subsequent independent verification detected a live change to one profile's
  `last_seen_at` column. There were no added/removed baseline rows and no changes
  to QC or notifications. This was retained, not restored from the old baseline.
  The application records visits in this field; an immutable snapshot is not
  expected to track later live activity.
- Repeating the import did not add duplicate rows or modify the saved snapshot.
- Six migration unit tests, TypeScript checking, ESLint, and rollback-only SQL
  tests passed. SQL tests exercised dangling links, unauthorized external links,
  invalid QC references, immutability, and API-role access denial.

All **241 attachment references and original file metadata** are retained.
File binaries still reside in Baserow; they were not copied to Supabase Storage.
Baserow must remain available for those URLs during this stage.

## Evidence and privacy

Private production artifacts are stored in the Git-ignored directory:

```text
migration-artifacts/2026-09-05T00-13-03-216Z_a594833a-f7b3-402f-9949-232d1a1f7b47/
```

It contains `snapshot.json`, `snapshot.sha256`, `report.json`, `stage.sql`,
`verify.sql`, `audit-before.json`, `audit-after.json`, `staged-document.json`,
`database-verification.json`, and `validation.json`. The final `validation.json`
records both snapshot integrity and later live baseline drift. The second local
capture is in `2026-09-05T00-20-14-856Z_880aec01-bcab-4ec5-b427-7bda38c1e3db`.

These files include production assignments, QC notes, profile data, and
notification content. Do not commit or publish them. The user explicitly
approved this local private destination. The Supabase baseline is an application
data capture, **not** a full Auth/Storage/project backup; Auth credentials and
secrets were not exported. SQL audit files contain fingerprints, not Auth values.

## Staging design

`supabase/staging/20260905_baserow_snapshot.sql` is outside the automatic
application migration directory. It only creates a new private schema. It has
already been applied to the project above. Do not replay it there: existing names
deliberately cause an error rather than silently accepting a different schema.
Do not run `supabase db reset`, `db push`, `config push`, or old QC/CAM migration
scripts as part of this procedure.

The schema contains:

- `snapshots`: immutable source document, Supabase baseline, checksum, and a
  separate staging timestamp; no original timestamp is replaced by this value.
- `source_tables`: original table IDs and complete field definitions.
- `source_rows`: original table/row IDs and lossless JSONB payloads.
- `source_links`: each source field, array position, target table, and target row,
  with foreign keys for in-scope relationships.
- `qc_references`: review provenance and verified requirement links, without
  changing or attaching new constraints to the authoritative `public.quality_control`.

The schema is not exposed through the Data API. RLS is enabled with no client
policies, and schema/table permissions are revoked from `anon`, `authenticated`,
and `service_role`. Use the existing privileged CLI/SQL access to inspect it.
Updates, deletes, and truncation are rejected by immutable-snapshot triggers.
New captures get new UUIDs; there is no destructive reset or source reconciliation.

The exporter uses **GET only**, rejects HTTP redirects, validates pagination,
and follows included link targets recursively. It preserves source anomalies
and reports them instead of repairing production data. Import is a single
transaction with an advisory lock, strict existing-public-data baseline checks,
conflict rejection, and complete staged-data verification. The prepared SQL
encodes production JSON as base64 so record content cannot become SQL code.

## Repeat a capture or verify the saved stage

Use the existing `.env.local` and linked Supabase CLI credentials. No new keys,
project, Auth settings, or public API configuration are required.

```powershell
npm run manufacturing:test-migration
npm run manufacturing:snapshot
# Use the exact new path printed by the exporter:
npm run manufacturing:prepare -- migration-artifacts/<capture>/snapshot.json
```

Read the generated `report.json`. Source drift during capture, inaccessible
in-scope tables, incomplete pages, unresolved internal links, or unresolved QC
requirements stop preparation. Fix the cause or recapture; do not edit the raw
snapshot to make validation pass.

After reviewing the generated SQL, an explicitly selected snapshot can be added
to the already-created private schema with:

```powershell
npx supabase db query --linked --project-ref ltyvookdgibzicplghte --file migration-artifacts/<capture>/stage.sql --output json
npx supabase db query --linked --project-ref ltyvookdgibzicplghte --file migration-artifacts/<capture>/verify.sql --output json
```

An import stops if existing public data has moved beyond its captured baseline.
Take a fresh snapshot; never overwrite live profiles/QC/notifications with the
baseline. Standalone verification checks the immutable copy and reports later
live changes separately. To regenerate only this read-only verification SQL:

```powershell
npm run manufacturing:prepare -- migration-artifacts/<capture>/snapshot.json --verify-only
```

`audit.sql` captures preservation fingerprints. `integration-test.sql` runs
fixture tests entirely inside a rolled-back transaction. `verify-artifacts.mts`
compares the original snapshot, a later capture, and saved CLI output from
`audit.sql`, `verify.sql`, and the staged-document readback. Preserve checkpoint
times when interpreting activity in an otherwise-live system.

## Next stage, requiring a separate cutover decision

The private snapshot is a validated staging copy, not the writable production
backend. The app still uses its original Baserow integration. No read-only lock
was installed on Baserow, and no existing app or Onshape/BOM sync was disabled;
the migration itself only read Baserow, consistent with leaving live configuration
unchanged. External writers may continue to change the live system.

Before cutover:

1. Implement and test the Supabase production adapter, including atomic claims,
   release/steal/undo, CAM prerequisites and handoffs, finishing, and QC actions.
   Preserve original requirement/operation IDs so existing QC and notification
   references keep resolving. Do not enable a demo fallback for missing live data.
2. Resolve upstream Onshape/BOM synchronization. Pause all writers during the
   final capture and cutover; two matching reads detect drift but are not a
   transactional freeze of Baserow. Recapture every included table and QC baseline.
3. Establish application read parity and authenticated role/access tests. Preserve
   QC history when implementing undo; existing app behavior is not changed here.
4. Copy and validate attachment bytes if Baserow file hosting will be retired.
5. Switch the live backend only after explicit cutover authorization. Retain the
   original Baserow data and validated snapshot for rollback. Once Supabase accepts
   new production writes, reverting to the old Baserow snapshot would discard
   progress unless those new changes are first reconciled.

Rollback for this staging-only phase requires no production switch: leave the
private copy unused. Do not delete Baserow or restore the older Supabase baseline.

API references: [Baserow database API](https://baserow.io/user-docs/database-api),
[Supabase database migrations](https://supabase.com/docs/guides/deployment/database-migrations).
