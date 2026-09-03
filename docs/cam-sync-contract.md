# CAM sync contract

The Onshape/BOM sync remains the owner of routing reconciliation. It must not
call Onshape merely to maintain CAM state; the following behavior operates on
the Baserow requirement and operation rows already produced by the sync.

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

For a safe initial migration, run `npm run cam:migrate` for a read-only preview,
then `npm run cam:migrate -- --apply --reset-all`. The explicit reset flag clears
all operation claims, attribution, and timestamps before rebuilding readiness.
The command accesses only the configured Baserow API; it contains no Onshape API
integration.
