# Supabase production writes

The application now supports coordinated Supabase reads and writes for claims,
releases, progress/completion and undo, claim stealing, CAM handoffs, finishing,
profile allocation renames, and QC review/undo. Baserow remains the safe default
until the database gate and both source flags are changed explicitly.

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
- is callable only with the server-side service role. Direct service-role table
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

## Coordinated cutover

Do not enable writes against an older candidate snapshot. First stop or otherwise
exclude Baserow writers, capture a final stable source state, import it, and rerun
read parity. Then:

1. Apply `supabase/production/20260905_manufacturing_writes.sql` once after the
   normalized manufacturing schema.
2. Confirm the RPC/table privilege checks and leave Baserow intact for recovery.
3. Enable the database gate:

   ```sql
   update manufacturing.write_control set enabled = true;
   ```

4. In the same deployment, set:

   ```ini
   REQUIRE_AUTH=true
   MANUFACTURING_READ_SOURCE=supabase
   MANUFACTURING_WRITE_SOURCE=supabase
   MANUFACTURING_SHADOW_READS=false
   ```

The app intentionally rejects a mixed Baserow-read/Supabase-write configuration;
otherwise a user could act on stale rows from the wrong authority. After Supabase
accepts its first production mutation, changing the flags back to the old Baserow
snapshot can discard visible work. Treat rollback as a data-reconciliation event,
not only an environment-variable change.

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
the requirement-to-part relationship and stream the private Supabase object. They
do not use the retained Baserow URL. Keep the original attachment metadata as
provenance until the application has been exercised after deployment.

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
