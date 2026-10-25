# Native manufacturing data

Runtime reads and write planning use current Supabase columns only. The read
projections and the write planner both work on the normalized rows as they are,
and share their column and quantity-ledger helpers (`lib/manufacturing/rows.ts`).
The planner patches copies of those rows and commits only the shop columns that
`manufacturing_commit` accepts; any `source_row` a row still carries is ignored.
Part names, numbers, assemblies, drawing links, and revisions never fall back to
archived lookup labels. Notifications and display projections share the same
identity resolver.

The original write-state RPC contains requirements, operations, and finishing.
The write adapter additionally reads parts and assemblies when they are absent
from that snapshot. These extra reads supply display context; the original
transaction token still protects shop-floor changes. Display identities can
reflect a concurrent engineering update independently of that token.

The cached read projection also takes QC reviews and retractions from the
write-state RPC. It returns one JSON value, so PostgREST's `max_rows` cap (1000)
cannot silently drop reviews the way a plain `quality_control` select would.

The Baserow-era staging snapshots, provenance columns (`source_row`,
`baserow_id`, `source_snapshot_id`), and imported work allocations remain in the
database. They are not sources for runtime identity or engineering fields. In
particular, existing worker credit must not be deleted merely because it was
imported.

## Verification

Run `npm test` and `npx tsc --noEmit`. Write-adapter fixtures omit migration
metadata, and a regression test injects stale `source_row` labels to verify they
cannot influence CAM notifications.
