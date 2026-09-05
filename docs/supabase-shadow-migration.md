# Normalized Supabase candidate and shadow validation

Completed September 4, 2026, on branch `supabase-migration`. This continues the
[staging report](baserow-supabase-staged-migration.md). **No deployment, backend
cutover, live environment change, Baserow write, or sync workflow change was made.**
The user deferred the Onshape sync rewrite (original step 10).

## Git and source preservation

The initial migration was committed as `3f7cb58`. `migration-artifacts/` remains
ignored. `.idea/dataSources*` and nested IDE data-source files are also ignored;
`.idea/dataSources.xml` was not committed. Python caches are ignored.

The exact supplied Onshape working version, its tests, requirements, and two
reference workflows are under `integrations/onshape/upstream/`.
[PROVENANCE.md](../integrations/onshape/upstream/PROVENANCE.md) records source HEAD
and SHA-256 hashes. The script/test had uncommitted changes in the source repo;
these were preserved without modifying that repo. The reference workflows live
outside `.github/workflows` and do not execute here. All 60 captured tests passed.
No sync rewrite or replacement deployment was attempted.

## Independent logical backup

A native PostgreSQL 17.6 logical backup completed before normalized tables were
created. Docker was unavailable; portable tools were downloaded from the official
EDB distribution. The current Supabase CLI supplied temporary login credentials
in memory; the user's recently changed database password was not needed or stored.

Verified backup copy outside this repository:

```text
C:\Users\corey\Documents\FRC190-Supabase-Backups\20260904-204337
```

The same backup is retained under ignored
`migration-artifacts/backups/20260904-204337/`.

- `database.dump`: consistent custom-format archive, 557,479 bytes.
- `schema.sql` and `data.sql`: extracted from that same archive.
- `roles.sql`: role metadata, excluding database-role passwords.
- `contents.txt` and `manifest.json`: archive inventory, sizes, and SHA-256 hashes.
- The external copy was verified against every manifest checksum.

The backup includes `public`, `auth`, `storage`, `frc190_baserow_stage`, and
`supabase_migrations`. It includes Auth user data, QC history, profiles,
notifications, original staging records, schema objects, and relevant sequences.
It is independent of the Baserow snapshot export. The archive was listed and
schema/data extracted successfully; **a full restore rehearsal was not performed**.

Platform settings/API secrets, role passwords, other platform-managed schemas,
and Storage object bytes are outside this logical backup. Storage was empty at
the earlier audit. This is not a complete Supabase platform backup.
`scripts/manufacturing-migration/backup.ps1` reproduces the backup using portable
tools in the ignored artifact folder; do not print the generated CLI credentials.

## Normalized candidate

Applied explicitly to `ltyvookdgibzicplghte`:

`supabase/production/20260905_normalized_manufacturing.sql`

This creates a separate `manufacturing` schema and one service-only read RPC,
`public.manufacturing_read_entity`. It does not change existing tables, QC
history, Auth, existing policies, or exposed-schema project settings. New tables
have RLS enabled and no client policies. Anonymous/authenticated roles cannot
read them or execute the RPC. The server's service key can execute the bounded,
allowlisted RPC; it has no direct table mutation grant.

| Candidate table | Imported rows |
| --- | ---: |
| assemblies | 12 |
| parts | 228 |
| requirements | 232 |
| operations | 388 |
| finishing | 45 |
| operation_allocations | 37 |
| locations | 0 |

Locations has a normalized table and foreign-key assignments on the candidate
entities. It starts empty because the user excluded Baserow Storage Locations.
Baserow App Users also remains excluded; existing Supabase profiles are retained.

Original row IDs are used as primary keys and retained in `baserow_id`. Original
production/operation keys are stored without rewriting. The source contains 64
duplicate operation-key groups and two blank operation keys; no rows were merged
or discarded. The app's existing display deduplication still chooses its original
canonical rows. Blank part numbers are also retained.

Typed columns cover manufacturing state, claims, timestamps, CAM handoffs,
engineering metadata, routes, and QC mirrors. `source_row` retains every original
field and exact formatting as provenance. Original ledger text remains verbatim,
with individual allocations additionally represented relationally. Legacy
claimant IDs are not guessed from names or forced into Auth foreign keys.
Timestamps retain their original strings when unchanged, with microsecond-aware
comparison. Foreign keys preserve part, assembly, requirement, and location links.
Authoritative QC stays in `public.quality_control`; no history is reinserted there.

## Import and retry behavior

```powershell
npm run manufacturing:import-prepare -- migration-artifacts/<capture>/snapshot.json
npx supabase db query --linked --project-ref ltyvookdgibzicplghte --file migration-artifacts/<capture>/import-normalized.sql --output json
```

Preparation validates the private snapshot hash/project and source relationships,
then creates reviewable SQL. The transaction requires the matching verified
staged snapshot, inserts missing IDs, compares typed existing records, and verifies
the result. It never updates existing rows or deletes absent rows. Any conflicting
current value, including changed progress, stops the transaction. Repeated imports
do not duplicate records. Sequence positions accommodate retained IDs.

The actual import and retry succeeded. A candidate-only rolled-back test changed
a claim and confirmed that the actual importer rejects it instead of restoring
the old value. Foreign-key and access-control fixture tests also passed.
Do not use this importer to refresh a candidate that has already accepted edits;
conflicts require review. No scheduled synchronization was added.

## Adapter, source flags, and invisible reads

`lib/manufacturing/` adds the candidate read adapter, pure projections captured
from the existing app, safe source selection, and comparisons. The original
`lib/baserow.ts` implementation is unchanged. Routes in this branch use the
gateway; the existing authentication and approval checks remain.

Defaults in code and `.env.example`:

```ini
MANUFACTURING_READ_SOURCE=baserow
MANUFACTURING_WRITE_SOURCE=baserow
MANUFACTURING_SHADOW_READS=false
```

No values were added to the live environment or `.env.local`. This phase provides
a **Supabase read adapter**. Supabase user-facing reads and production writes are
deliberately gated off, even if a source flag is changed. Baserow continues to own
live mutations. QC checks the write gate before any existing Supabase QC mutation.
A complete atomic Supabase write adapter and explicit cutover remain future work.

The standalone command performs invisible GET-only source comparisons now:

```powershell
npm run manufacturing:shadow
```

It reads Baserow before and after the candidate reads, checks source stability,
and compares original raw values plus complete Operations, Production, Finishing,
and QC projections. Reports contain IDs/changed field names, not private values.
A dirty comparison exits nonzero. Production groups use the same current UI
grouping rules. QC and finishing notes use the existing authoritative QC data.

For a future deployment of this branch, `MANUFACTURING_SHADOW_READS=true` enables
after-response comparisons for operations/production, finishing, and QC while
still returning Baserow responses. Failures log a shadow-only warning and do not
replace the user's response. This option was not enabled on the live deployment.
Background comparisons can observe activity between reads; the standalone command
provides the source-stability check.

The live comparison at `2026-09-05T01:09:34.428Z` was clean:

| View | Compared items | Result |
| --- | ---: | --- |
| Operations | 323 | Exact match |
| Production | 195 | Exact match |
| Finishing | 45 | Exact match |
| QC | 8 | Exact match |

All 905 underlying rows across the five imported entities also matched (including
assemblies); the original staging snapshot additionally retains 236 Sync Runs.
The private report is under `migration-artifacts/shadow/`. Attachment references
are unchanged; binaries continue to use Baserow hosting.

## Validation and remaining boundary

The normalized schema/import passed a rollback preview before application.
Import retry, changed-progress refusal, SQL access/link tests, 13 migration unit
tests, 60 captured sync tests, full ESLint, TypeScript checking, and the production
build passed. The production build was not deployed.

Live Baserow and the existing Onshape sync remain operational. Source changes
after a comparison can make the candidate stale. Clean read parity does not
authorize a cutover or establish atomic write parity. Preserve the original
services until a later approved cutover. The Onshape sync rewrite is deferred.

References: [Supabase backup/restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore),
[Supabase database functions](https://supabase.com/docs/guides/database/functions).
