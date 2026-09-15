# Native manufacturing data

Runtime reads and write planning use current Supabase columns only. `runtimeRow`
maps those columns to the workflow field names without copying `source_row`.
Part names, numbers, assemblies, drawing links, and revisions never fall back to
archived lookup labels. Notifications and display projections share the same
identity resolver. Write planning uses entity names instead of Baserow table IDs.

The original write-state RPC contains requirements, operations, and finishing.
The write adapter additionally reads parts and assemblies when they are absent
from that snapshot. These extra reads supply display context; the original
transaction token still protects shop-floor changes. Display identities can
reflect a concurrent engineering update independently of that token.

Historical migration scripts, immutable snapshots, provenance columns, and
imported work allocations remain preserved. They are not sources for runtime
identity or engineering fields. In particular, existing worker credit must not
be deleted merely because it was imported. `denormalizeRow` remains available
for historical migration/parity tooling only.

## Verification

Run `npm test`, `npm run manufacturing:test-migration`, and `npx tsc --noEmit`.
Write-adapter fixtures omit migration metadata, and regression tests also inject
stale labels to verify they cannot influence CAM notifications.

For a read-only check against the configured database:

```powershell
node --experimental-strip-types --env-file=.env.local scripts/audit-native-manufacturing.mts
```

This audits requirement relationships and reports current identities. It does
not commit writes, delete data, or send Slack notifications. The database in
this checkout at verification time did not contain assembly `a26c-0002`.
