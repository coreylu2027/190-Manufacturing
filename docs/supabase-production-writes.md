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
- rejects a stale token with PostgREST SQLSTATE `PT409`, surfaced to the UI as HTTP 409;
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

Every write requires a real authenticated, approved profile. Bootstrap
administrators are persisted to `profiles` so the database authorization check
matches the application role.

Claiming a print or completing manufacturing work can also set the part location
in the same transaction. These combined writes use the same
retry fingerprint and snapshot protection as other manufacturing actions, and
their location audit is stored as `part_locations` alongside workflow history.
The location remains shared by all quantities of a production requirement.

## Verification

`npm test` covers the TypeScript write adapter and runs
`scripts/manufacturing-migration/write-rpcs.test.mts`, which installs the
complete schema into in-memory PostgreSQL (PGlite) and tests commit, rollback,
stale-write rejection, retry idempotency, QC history, part locations, audit
history, Realtime invalidation, and grants.

## Production activation

For a new Supabase environment, follow these steps in order. The SQL tests
install the same SQL order (`SCHEMA_ORDER` in
`scripts/manufacturing-migration/pglite-fixture.mts`) on stand-ins for hosted
Supabase, the staging table, and the engineering-sync API. Because the sync API
is a stand-in, the tests skip the two migrations that patch it
(`20260906143937_preserve_cam_operations.sql` and
`20260926000000_cots_parts.sql`), so those two migrations and the placement of
the sync install are not covered by tests. Applying `supabase/migrations` in
filename order does not work, because the manufacturing schema comes from
`supabase/production`.

1. Apply `supabase/staging/20260905_baserow_snapshot.sql`. The normalized
   schema's provenance columns still reference its (empty) `snapshots` table.
2. Apply the files in `supabase/migrations` up to and including
   `20260909174808_qc_rejected_quantities.sql`, in filename order, except
   `20260906143937_preserve_cam_operations.sql` (step 7).
3. Apply `supabase/production/20260905_normalized_manufacturing.sql`, then
   `20260905_manufacturing_writes.sql`.
4. Apply the rest of `supabase/production`:
   - `20260905_qc_storage_locations.sql` adds the location-aware write wrapper
     used by the application.
   - `20260905_part_locations.sql` moves location ownership onto production
     requirements.
   - `20260905_manufacturing_attachments.sql` creates the private attachment
     catalog and resolver.
   - `20260906_manufacturing_realtime.sql` creates a private
     `manufacturing:changes` Broadcast topic for approved users. The payload is
     only an invalidation signal; browsers continue reading the projected data
     through authenticated application routes.
   - `20260906_manufacturing_shared_cache.sql` adds a server-only data-version
     RPC, changes invalidation to one Broadcast per changed table statement, and
     supplies the common key used by the Next.js Data Cache. Connected browsers
     still receive fresh responses, but the full manufacturing projection is
     loaded from Supabase only once per database transaction version and shared
     across Vercel requests.
   - `20260907_manufacturing_part_previews.sql` adds the private,
     source-hash-bound GLB derivative catalog and server-only
     resolver/registration functions. It does not alter the source STEP objects.
   - `20260909_requirement_notes.sql` adds the production-requirement note, an
     append-only revision history for production and inspection notes, and the
     approved-user write RPC used by the shop UI.
   - `20260909_qc_rejected_quantities.sql` installs the atomic QC write wrapper
     with rejected quantities.
   - `supabase/migrations/20260916162511_printer_locations.sql`, then
     `20260916_operation_locations.sql`, which adds the combined claim or
     completion plus location write.

   `20260910_postgrest_40001_hotfix.sql` only patched installations created
   before September 10, 2026; a new environment does not need it, because the
   production files already use `PT409`.
5. In Supabase Storage, create a private bucket named `manufacturing-files`
   (public access off) unless it already exists; nothing in this repository
   creates it. Synced attachments, the file routes, admin replacement uploads,
   and the preview scripts all use it. If you restrict its MIME types, allow
   `application/pdf` and `application/step`; step 8 adds `model/gltf-binary`
   and raises a size limit below 50 MB to 50 MB.
6. Install the engineering-sync API from the Onshape repository. It provides
   `manufacturing.engineering_sync_runs` and
   `public.manufacturing_apply_engineering_sync`, which later migrations hook
   and patch.
7. Apply the remaining files in `supabase/migrations` in filename order:
   `20260906143937_preserve_cam_operations.sql`, then
   `20260910031802_assembly_glb_previews.sql` onward (skipping
   `20260916162511_printer_locations.sql`, applied in step 4).
8. Generate and verify the current STEP previews:

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
9. Confirm the RPC, table privilege, Realtime policy, and trigger checks.
10. Enable the database gate:

    ```sql
    update manufacturing.write_control set enabled = true;
    ```

    Disabling it again safely stops new manufacturing mutations.
11. Deploy the application with the Supabase URL, publishable key, secret key,
    and bootstrap administrator list.

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

## Private file storage

The operation and finishing file routes resolve the authenticated request through
the requirement-to-part relationship and stream the private Supabase object.
Availability and exact display/download names come from the private Supabase
attachment catalog; retained source metadata is migration provenance only.

Storage object keys are content-addressed to make collision and corruption checks
unambiguous. The original PDF/STEP name remains authoritative in the private
catalog and in the route's `Content-Disposition` response header, so downloaded
files retain the original naming convention.
