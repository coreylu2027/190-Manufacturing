# Supabase production writes

The application now supports coordinated Supabase reads and writes for claims,
releases, progress/completion and undo, claim stealing, CAM handoffs, finishing,
profile allocation renames, QC review/undo, and requirement-level part locations. Supabase is the only application
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
- accepts an optional canonical part location with a passing review, permits
  location changes at any workflow stage, and guards `On Robot` behind an
  effective QC pass plus completed finishing;
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
5. Apply `supabase/production/20260905_part_locations.sql`. This moves location
   ownership onto production requirements and preserves existing values; its
   numbered prerequisite was applied in step 1.
6. Apply `supabase/production/20260905_manufacturing_attachments.sql` to create
   the private attachment catalog and resolver.
7. Apply `supabase/production/20260906_manufacturing_realtime.sql`. This creates
   a private `manufacturing:changes` Broadcast topic for approved users. The
   payload is only an invalidation signal; browsers continue reading the
   projected data through authenticated application routes.
8. Apply `supabase/production/20260906_manufacturing_shared_cache.sql`. This
   adds a server-only data-version RPC, changes invalidation to one Broadcast
   per changed table statement, and supplies the common key used by the Next.js
   Data Cache. Connected browsers still receive fresh responses, but the full
   manufacturing projection is loaded from Supabase only once per database
   transaction version and shared across Vercel requests.
9. Apply `supabase/production/20260907_manufacturing_part_previews.sql`. This
   adds the private, source-hash-bound GLB derivative catalog and server-only
   resolver/registration functions. It does not alter the source STEP objects.
10. Apply `supabase/production/20260909_requirement_notes.sql`. This adds the
    production-requirement note, an append-only revision history for production
    and inspection notes, and the approved-user write RPC used by the shop UI.
11. Apply `supabase/production/20260909_qc_rejected_quantities.sql`. This
    backfills failed-review quantities, fully resets legacy `Needs Rework`
    routes, removes remaining legacy rework states, and installs the atomic QC
    write wrapper used by the application.
12. Generate and verify the current STEP previews:

   ```powershell
   npm run manufacturing:generate-previews -- --apply
   ```

   The command keeps the `manufacturing-files` bucket private, adds
   `model/gltf-binary` to its upload allowlist, validates each stored STEP,
   converts it with OpenCascade, verifies the uploaded GLB by size and SHA-256,
   and only then registers it. Re-running the command skips verified derivatives
   made by the current generator. Use `--force` only to deliberately regenerate
   them, or `--limit=<count>` for a bounded rollout.

   Tessellation is explicit and versioned: millimeter output, linear deflection
   of `0.001` times the average bounding-box dimension, and angular deflection
   of `0.5` radians. Changing any of these settings requires a generator-version
   bump and regeneration so mixed-quality derivatives cannot be mistaken for a
   uniform preview set.
13. Confirm the RPC, table privilege, Realtime policy, and trigger checks.
14. Enable the database gate:

   ```sql
   update manufacturing.write_control set enabled = true;
   ```

15. Deploy the application with the Supabase URL, publishable key, secret key,
   and bootstrap administrator list. There are no backend source-selection flags.

For an existing normalized installation, apply any unapplied scripts in the
order above. Apply both September 9 scripts before deploying application code
that exposes the note editor or rejected-quantity QC flow.

The browser does not poll when Realtime is unavailable. It shows `Manual
refresh` and retains the explicit refresh button, avoiding a full request every
10 seconds on disconnected tabs. The shared cache is versioned by a private
database transaction identifier; authentication and user-specific response
fields remain outside the cache.

## Interactive part previews

The production, operation, and finishing detail panels lazy-load an interactive
GLB viewer when the selected part has a STEP attachment. Preview requests use
the same authenticated, approved-account checks as the original file routes.
The server resolves a derivative only when its registered `source_sha256` still
matches the selected source STEP, so a revised source cannot silently display an
old model. Responses use a private SHA-256 ETag and never reveal Storage paths or
server credentials.

Conversion is intentionally an offline deployment/synchronization step rather
than request-time work. This keeps OpenCascade and the source STEP bytes out of
the browser bundle, avoids CPU-heavy conversion on shop tablets, and lets the
application serve a compact model immediately. The original STEP remains the
authoritative downloadable file.

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
