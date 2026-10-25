# Native manufacturing data

Runtime reads and write planning use current Supabase columns only. `runtimeRow`
maps those columns to the workflow field names without copying `source_row`.
Part names, numbers, assemblies, drawing links, and revisions never fall back to
archived lookup labels. Notifications and display projections share the same
identity resolver.

The original write-state RPC contains requirements, operations, and finishing.
The write adapter additionally reads parts and assemblies when they are absent
from that snapshot. These extra reads supply display context; the original
transaction token still protects shop-floor changes. Display identities can
reflect a concurrent engineering update independently of that token.

The Baserow-era staging snapshots, provenance columns (`source_row`,
`baserow_id`, `source_snapshot_id`), and imported work allocations remain in the
database. They are not sources for runtime identity or engineering fields. In
particular, existing worker credit must not be deleted merely because it was
imported.

## Verification

Run `npm test` and `npx tsc --noEmit`. Write-adapter fixtures omit migration
metadata, and regression tests also inject stale labels to verify they cannot
influence CAM notifications.
