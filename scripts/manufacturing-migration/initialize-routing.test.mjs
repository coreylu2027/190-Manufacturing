// Runs in isolated PostgreSQL/WASM; never contacts Supabase or Onshape.
import assert from "node:assert/strict";
import { createSchemaDatabase } from "./pglite-fixture.mts";
const { db, sql } = await createSchemaDatabase();
const requirement = async (key, status = null, active = true) => (await sql(
  "insert into manufacturing.requirements(production_key,required_quantity,active_in_bom,status) values($1,2,$2,$3) returning id",
  [key, active, status],
))[0].id;
const operation = async (req, key, machine, number = "OP1", status = null) => (await sql(
  `insert into manufacturing.operations(operation_key,requirement_id,machine,operation_number,work_type,active_in_routing,status)
   values($1,$2,$3,$4,'Manufacturing',true,$5) returning id`, [key, req, machine, number, status],
))[0].id;
const state = async () => ({
  requirements: await sql("select * from manufacturing.requirements order by id"),
  operations: await sql("select * from manufacturing.operations order by id"),
});
const cnc = await requirement("cnc");
await operation(cnc, "cnc|OP1", "Haas CNC");
await operation(cnc, "cnc|OP2", "Countersinking", "OP2");
const later = await requirement("later");
await operation(later, "later|OP1", "Bandsaw");
await operation(later, "later|OP2", "Shop Sabre CNC", "OP2");
const existing = await requirement("existing", "On Machine");
const working = await operation(existing, "existing|OP1", "Haas CNC", "OP1", "In Progress");
await sql("update manufacturing.operations set claimed_quantity=2,machinist='Existing claimant',started_at=now(),cam_notes='Keep setup' where id=$1", [working]);
const beforeWorking = (await sql("select * from manufacturing.operations where id=$1", [working]))[0];
const unrouted = await requirement("unrouted");
const inactive = await requirement("inactive", null, false);
await operation(inactive, "inactive|OP1", "Bandsaw");
const postQc = await requirement("postqc", "Ready for Finishing");
await sql("update manufacturing.requirements set qc_outcome='Passed',finishing='Red' where id=$1", [postQc]);
await operation(postQc, "postqc|OP2", "Threaded Insert", "OP2");

await db.exec("select manufacturing.initialize_synced_routing()");
const initialized = await state();
const ops = id => initialized.operations.filter(o => o.requirement_id === id);
assert.deepEqual(ops(cnc).map(o => [o.work_type, o.status]), [["Manufacturing", "Planned"], ["Manufacturing", "Planned"], ["CAM", "Ready"]]);
assert.deepEqual(ops(later).map(o => [o.work_type, o.status]), [["Manufacturing", "Ready"], ["Manufacturing", "Planned"], ["CAM", "Ready"]]);
assert.equal(ops(later)[2].operation_key, "later|CAM|OP2");
assert.deepEqual(ops(existing), [beforeWorking]);
assert.equal(ops(inactive)[0].status, null);
assert.equal(ops(postQc)[0].status, "Planned");
assert.equal(initialized.requirements.find(r => r.id === cnc).status, "Ready for CAM");
assert.equal(initialized.requirements.find(r => r.id === unrouted).status, "Needs Triage");
await db.exec("select manufacturing.initialize_synced_routing()");
assert.deepEqual(await state(), initialized);
assert.equal((await sql("select has_function_privilege('service_role','manufacturing.initialize_synced_routing()','execute') allowed"))[0].allowed, false);

// Future successful/partial sync completion initializes new work in its transaction.
await db.exec("insert into manufacturing.engineering_sync_runs values(1,'running')");
const future = await requirement("future");
await operation(future, "future|OP1", "Bandsaw");
await db.exec("update manufacturing.engineering_sync_runs set status='failed' where id=1");
assert.equal((await sql("select status from manufacturing.operations where requirement_id=$1", [future]))[0].status, null);
await db.exec("insert into manufacturing.engineering_sync_runs values(2,'running'); update manufacturing.engineering_sync_runs set status='partial' where id=2");
assert.equal((await sql("select status from manufacturing.operations where requirement_id=$1", [future]))[0].status, "Ready");
assert.equal((await sql("select status from manufacturing.requirements where id=$1", [future]))[0].status, "Ready for Manufacturing");
await db.close();
console.log("Routing initialization passed: CAM, stage ordering, QC gate, preserved work, idempotence, grants, and future syncs.");
