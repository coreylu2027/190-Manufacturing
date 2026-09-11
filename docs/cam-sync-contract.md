# CAM sync contract

The Onshape/BOM sync remains the owner of routing reconciliation. It must not
call Onshape merely to maintain CAM state; the following behavior operates on
the normalized Supabase requirement and operation rows already produced by the sync.

For every active Production Requirement with a routed `Machine OPn` of `Haas
CNC` or `Shop Sabre CNC`, upsert one Operations row with:

- the same Production Requirement, Operation Number, and target Machine;
- `Work Type` set to `CAM`;
- a deterministic primary key of `<Production Key>|CAM|<OPn>`; and
- `Active in Routing` set to true.

An unchanged task must retain its status, claims, timestamps, program path, and
notes. Deactivate its CAM row when the target CNC route is removed. If an
unstarted target changes between CAM-required machines, clear and reset the CAM
task to `Ready`; do not disrupt a target that has already started.

After route reconciliation, apply `planRequirementWorkflow` from
`lib/manufacturing-workflow.ts` (or equivalent logic) to set unstarted
operation readiness and the Production Requirement status. This makes future
syncs idempotent and keeps CAM for a later operation independent of earlier
physical work.

## Initializing new Supabase routes

Apply `supabase/migrations/20260911033920_initialize_synced_routing.sql` after
the normalized manufacturing schema and the engineering-sync API from the
Onshape repository. It initializes newly inserted, untouched operations whose
status is null and creates their missing CAM prerequisites. A private trigger
runs the same initialization when a future engineering sync succeeds or
partially succeeds, inside that sync's transaction. Failed syncs do not run it.

This initialization preserves existing operation and requirement statuses,
claims, timestamps, CAM handoffs, and QC data. Rows with evidence of shop work
but a null operation status require review and are left untouched. Requirements
without a routed OP1 receive `Needs Triage`; the initializer does not invent
machine selections. Reconciliation of changes to already initialized routes
remains subject to the contract above.

Test with `node scripts/manufacturing-migration/initialize-routing.test.mjs`.
Set `PGLITE_MODULE` to an installed PGlite module entrypoint if it is not in
`node_modules`. Optionally set `ROUTING_SNAPSHOT` to a private local JSON export
of the five normalized manufacturing entities to verify that initialized work
is preserved. Tests run only in memory and never call Supabase or Onshape.
