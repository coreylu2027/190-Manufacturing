# Supabase production writes

The application now supports coordinated Supabase reads and writes for claims,
releases, progress/completion and undo, claim stealing, CAM handoffs, finishing,
profile allocation renames, QC review/undo, and post-QC storage locations. Supabase is the only application
backend; missing server credentials fail closed.

## Safety model

Every action first reads one canonical database snapshot and computes its workflow
changes in memory. `public.manufacturing_commit` then commits the complete change
set in one PostgreSQL transaction. It:

- obtains table locks in a fixed order before checking the snapshot token;
- rejects a stale token with SQLSTATE `40001`, surfaced to the UI as HTTP 409;
- records an idempotency key so a transport retry cannot apply an action twice;
- limits patches to shop-owned columns and rebuilds relational allocations from
  the validated quantity ledger;
- records immutable before/after audit rows;
- stores QC review/retraction and workflow changes in the same transaction; and
- accepts an optional canonical storage location with a passing review, and
  permits later location changes only while that review remains an effective pass;
- is callable only with the server-side secret key, which assumes the database
  `service_role`. Direct service-role table
  updates remain revoked.

Supabase mode requires a real authenticated, approved profile. Configuring either
Supabase manufacturing source also forces application authentication. Bootstrap
administrators are persisted to `profiles` so the database authorization check
matches the application role.

## Verification

The TypeScript adapter suite is part of:

```powershell
npm run manufacturing:test-migration
```

The SQL regression suite is intended for an isolated stock PostgreSQL database.
It installs Supabase-compatible stubs and the real schema, then tests commit,
rollback, stale-write rejection, retry idempotency, QC history, audit history,
and grants:

```powershell
psql -d manufacturing_write_test -f scripts/manufacturing-migration/write-test-bootstrap.sql
psql -d manufacturing_write_test -f scripts/manufacturing-migration/write-integration-test.sql
```

The integration test wraps all fixture writes in a rollback. The bootstrap file
must only be used with a new isolated database, never the hosted project.

## Production activation

For a new Supabase environment:

1. Apply every file in `supabase/migrations` in filename order, including
   `202609050001_qc_storage_locations.sql`.
2. Apply `supabase/production/20260905_normalized_manufacturing.sql`.
3. Apply `supabase/production/20260905_manufacturing_writes.sql`.
4. Apply `supabase/production/20260905_qc_storage_locations.sql`. This adds the
   location-aware write wrapper used by the application.
5. Confirm the RPC and table privilege checks.
6. Enable the database gate:

   ```sql
   update manufacturing.write_control set enabled = true;
   ```

7. Deploy the application with the Supabase URL, publishable key, secret key,
   and bootstrap administrator list. There are no backend source-selection flags.

For an existing normalized installation, apply only the new numbered location
migration and the location wrapper, in that order, before deploying this code.

After Supabase accepts its first production mutation, rollback must preserve the
Supabase database as the authority. Disabling the write gate safely stops new
manufacturing mutations without redirecting traffic to another database.

## Attachment migration

Apply `supabase/production/20260905_manufacturing_attachments.sql`, then copy and
verify the preserved attachment references from the private snapshot:

```powershell
npm run manufacturing:migrate-attachments -- migration-artifacts/<capture>/snapshot.json --apply
```

The command creates or reuses the private `manufacturing-files` bucket, downloads
only allowlisted Baserow HTTPS objects, validates every declared byte count,
computes SHA-256, uploads to a content-addressed path, downloads the stored object
again, and compares its size and SHA-256 before registering it. Registration is
idempotent and rejects changed metadata. A final database manifest must match all
verified source files before the command succeeds.

The operation and finishing file routes resolve the authenticated request through
the requirement-to-part relationship and stream the private Supabase object.
Availability and exact display/download names come from the private Supabase
attachment catalog; retained source metadata is migration provenance only.

### Completed attachment transfer

The linked project transfer completed on September 5, 2026:

- 241 of 241 references copied: 105 PDFs and 136 STEP files;
- 45,097,273 source bytes matched the downloaded Supabase objects by size and
  SHA-256;
- all files passed their PDF or ISO 10303-21 STEP structural signatures;
- all 241 exact Baserow `visible_name` values were preserved as the download
  filename, including punctuation, capitalization, spaces, and extensions;
- all 246 requirement/file resolver combinations matched the registered object;
  and
- the bucket is private, with anonymous catalog and object access denied.

Storage object keys are content-addressed to make collision and corruption checks
unambiguous. The original PDF/STEP name remains authoritative in the private
catalog and in the route's `Content-Disposition` response header, so downloaded
files retain the original naming convention.
