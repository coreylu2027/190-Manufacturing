// In-memory PostgreSQL only. Set PGLITE_MODULE to an installed PGlite entrypoint.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const { PGlite } = await import(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const db = new PGlite();
const sql = async (query, params = []) => (await db.query(query, params)).rows;
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema frc190_baserow_stage;
  create table frc190_baserow_stage.snapshots(id uuid primary key);
`);
await db.exec(await readFile(new URL("../../supabase/production/20260905_normalized_manufacturing.sql", import.meta.url), "utf8"));
await db.exec("create table manufacturing.engineering_sync_runs(id integer primary key, status text)");
if (process.env.ROUTING_SNAPSHOT) {
  const snapshot = JSON.parse(await readFile(process.env.ROUTING_SNAPSHOT, "utf8"));
  for (const name of ["assemblies", "parts", "requirements", "operations", "finishing"]) {
    for (const row of snapshot[name]) {
      if (row.source_snapshot_id) await sql("insert into frc190_baserow_stage.snapshots values($1) on conflict do nothing", [row.source_snapshot_id]);
      await sql(`insert into manufacturing.${name} select * from jsonb_populate_record(null::manufacturing.${name},$1)`, [JSON.stringify(row)]);
    }
    await db.exec(`select setval(pg_get_serial_sequence('manufacturing.${name}','id'), greatest(1,(select max(id) from manufacturing.${name})))`);
  }
  const before = await sql("select * from manufacturing.operations order by id");
  const beforeRequirements = await sql("select * from manufacturing.requirements order by id");
  await db.exec(await readFile(new URL("../../supabase/migrations/20260911033920_initialize_synced_routing.sql", import.meta.url), "utf8"));
  const after = await sql("select * from manufacturing.operations order by id");
  const afterRequirements = await sql("select * from manufacturing.requirements order by id");
  for (const row of before.filter(o => o.status !== null)) assert.deepEqual(after.find(o => o.id === row.id), row);
  for (const row of beforeRequirements.filter(r => r.status !== null)) assert.deepEqual(afterRequirements.find(r => r.id === row.id), row);
  assert.equal(after.filter(o => o.active_in_routing && o.status === null).length, 0);
  console.log(JSON.stringify({initializedOperations:before.filter(o=>o.active_in_routing&&o.status===null).length,
    createdCamTasks:after.length-before.length,existingOperationsPreserved:before.filter(o=>o.status!==null).length}));
  await db.close();
  process.exit(0);
}
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

await db.exec(await readFile(new URL("../../supabase/migrations/20260911033920_initialize_synced_routing.sql", import.meta.url), "utf8"));
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
