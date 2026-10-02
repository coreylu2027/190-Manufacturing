# Onshape → Supabase engineering sync

`OnshapeToSupabase.py` resolves released manufacturing roots in Onshape, builds
the engineering records (assemblies, parts, production requirements, routing,
finishing, drawing PDFs, and STEP files), and hands them to Supabase in one
transactional RPC. Shop workflow, assignments, QC, locations, and production
quantities stay shop-owned.

Moved here from `Team-190/.github` (`pre-2027-onshape_ci/`, branch
`cots-parts-sync`, commit `900a1fd`). The Poot Horse workflow now lives in this
repository and **stages** each sync for administrator review instead of
committing it. See [the review runbook](../../docs/engineering-sync-review.md).
The delta workflow and the Baserow-era capture in [`upstream/`](upstream) are
not wired up here.

| Path | Purpose |
| --- | --- |
| `OnshapeToSupabase.py` | The sync CLI |
| `test_onshape_to_supabase.py` | Mocked-Onshape unit tests (`npm run onshape:test`) |
| `tests/*.test.mjs`, `tests/fixtures/` | PGlite tests of the engineering RPC against its contract fixtures |
| `../../supabase/production/20260906_onshape_engineering_sync.sql` | The engineering RPC, plus `20260910_preserve_unchanged_part_revisions.sql` |
| `../../.github/workflows/onshape-sync-poot-horse.yml` | Staged Poot Horse sync |
| `../../.github/workflows/onshape-sync-tests.yml` | Offline tests on pull requests |

## Modes

- **Staged (Poot Horse workflow):** `STAGE_FOR_REVIEW=true` or
  `--stage-for-review`. Files are exported and uploaded to private Storage as
  usual, then the payload is stored by `manufacturing_stage_engineering_sync`.
  Admins approve, trim, or deny it at `/admin/sync`.
- **Direct:** without the flag, the payload commits immediately through
  `manufacturing_apply_engineering_sync`, as the old workflows did.
- **Dry run:** `--dry-run [--output-json PATH]` reads Onshape only. It needs no
  Supabase credentials, never generates a missing BOM, starts no translations,
  and uploads nothing.

## Configuration

| Variable | Purpose |
| --- | --- |
| `ONSHAPE_ACCESS_KEY`, `ONSHAPE_SECRET_KEY` | Onshape API key pair |
| `USE_SUBASSEMBLY_LIST`, `ONSHAPE_SUBASSEMBLY_URLS` | Sync this list of manufacturing-root URLs (the workflow default) |
| `ONSHAPE_DOC_URL` | Main-workspace assembly to discover direct children from, when the list is off |
| `PARTNUMBER_PREFIXES` | Team part-number prefixes, such as `P-190B-26` |
| `SYNC_CAD_FILES` | Export drawing PDFs and STEP files |
| `SYNC_COTS_PARTS` | Sync purchased parts (disabled; see below) |
| `FORCE_REFRESH` / `--force-refresh` | Rebuild every resolved root, even at unchanged revisions |
| `ONSHAPE_EXPORT_TIMEOUT_SECONDS` | Per-translation timeout |
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Supabase project URL and server-side secret key |
| `STAGE_FOR_REVIEW`, `SYNC_LABEL` | Stage for review, and the name admins see ("Poot Horse") |
| `MANUFACTURING_APP_URL` | Optional app origin, used for the review link in the job summary |
| `GITHUB_RUN_URL` | Recorded on the sync run |

Secret keys use the `apikey` header; legacy service-role JWTs also get
`Authorization: Bearer`. Keys are never written to files or dry-run output, and
HTTP redirects are refused.

## Ownership and atomicity

The client submits business keys, never database IDs: assemblies by
`assembly_number`, parts by `part_number`, and dependent work by
`production_key`. Requirement keys include the required **part** revision, not
the parent assembly revision, so releasing a parent updates an unchanged part's
requirement in place and its shop work survives. A changed part revision
creates a new requirement and retires the old one. A part number that resolves
to two different Onshape parts aborts the run before any database call.

The RPC upserts an explicit engineering allowlist and rejects shop fields. Only
fully processed roots enter `synced_roots`; their stale requirements, operations
and finishing rows deactivate together, while failed, unresolved, and unchanged
roots keep their work. Missing Main children are flagged `Missing from Main —
Review` rather than deactivated.

Each run records an audit row before resolving Onshape. Any error inside the
RPC rolls back every BOM, marker, and attachment change and records the run as
failed. Engineering commits are serialized, and a run that started before a
newer commit is rejected and must resolve fresh state. Shop transactions don't
take the engineering lock.

## Files and API budget

PDF/STEP bytes are exported only when CAD sync is enabled and the part's export
key changed. Content hashes define private `sha256/<prefix>/<digest>.pdf|.step`
paths; uploads never overwrite, and duplicates are verified byte for byte.
Storage and PostgreSQL can't share a transaction, so a failed or denied sync can
leave unreferenced private objects. A later run reuses them.

Unchanged released root revisions exit before BOM, metadata, or drawing scans.
Nested BOM quantities multiply through every enclosing subassembly. Changed
roots share document-name, bulk part-metadata, and document-revision caches.

## COTS parts

Built but disabled. Rollout: apply
`supabase/migrations/20260926000000_cots_parts.sql`, set `SYNC_COTS_PARTS` to
`"true"` in the workflow, then run it once with `force_refresh=true`.

## Tests

```sh
npm run onshape:test      # Python, mocked Onshape and Supabase
npm run onshape:test-sql  # PGlite: engineering RPC, imported data, staged review
```

Neither contacts Onshape or Supabase.
