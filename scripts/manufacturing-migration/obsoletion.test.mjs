// Runs in isolated PostgreSQL/WASM; never contacts Supabase or Onshape.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
const db = new PGlite();
const sql = async (query, params = []) => (await db.query(query, params)).rows;
const install = async (path) => db.exec(await readFile(new URL(`../../${path}`, import.meta.url), "utf8"));
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth; create table auth.users(id uuid primary key);
  create table public.profiles(id uuid primary key, display_name text, approved boolean, role text);
  create type public.quality_result as enum ('passed','failed');
  create table public.quality_control(id bigint generated always as identity primary key,
    production_requirement_id bigint, operation_id bigint, result public.quality_result,
    notes text, rejected_quantity integer, reviewed_by uuid, reviewed_at timestamptz, updated_at timestamptz);
  create schema frc190_baserow_stage; create table frc190_baserow_stage.snapshots(id uuid primary key);
`);
await install("supabase/production/20260905_normalized_manufacturing.sql");
await install("supabase/production/20260905_manufacturing_writes.sql");
await install("supabase/production/20260909_requirement_notes.sql");
await db.exec("create table manufacturing.engineering_sync_runs(id integer primary key, status text)");
await install("supabase/migrations/20260911033920_initialize_synced_routing.sql");
await install("supabase/migrations/20260918162451_requirement_obsoletion.sql");
const actor = "00000000-0000-4000-8000-000000000190";
await sql("insert into auth.users values($1)", [actor]);
await sql("insert into public.profiles values($1,'Alex A.',true,'machinist')", [actor]);
await db.exec(`update manufacturing.write_control set enabled=true;
  insert into manufacturing.parts(id,part_number) values(1,'P-1');
  insert into manufacturing.assemblies(id,assembly_number) values(1,'A-1'),(2,'A-2');`);
const requirement = async (key, revision = "A", assembly = 1) => (await sql(`
  insert into manufacturing.requirements(production_key,part_id,assembly_id,source_root,configuration,
    required_part_revision,source_assembly_revision,active_in_bom,required_quantity,status,qc_outcome)
  values($1,1,$3,'ROOT','default',$2,$2,true,2,'Complete','Passed') returning id`, [key, revision, assembly]))[0].id;
const operation = async (id) => (await sql(`insert into manufacturing.operations(operation_key,requirement_id,
  operation_number,work_type,machine,active_in_routing,status,completed_quantity,claimed_quantity,quantity_ledger)
  values($1,$2,'OP1','Manufacturing','Mill',true,'Complete',2,0,'[]') returning id`, [`${id}|OP1`, id]))[0].id;
const row = async (id) => (await sql("select * from manufacturing.requirements where id=$1", [id]))[0];
const token = async () => (await sql("select md5(manufacturing.write_snapshot()::text) token"))[0].token;
const change = async (id, obsolete, version, expected, request = crypto.randomUUID()) => (await sql(
  "select public.manufacturing_set_requirement_obsolete($1,$2,$3,$4,$5,$6) result",
  [request, actor, expected ?? await token(), id, obsolete, version]))[0].result;
const old = await requirement("old");
const op = await operation(old);
const unrelated = await requirement("unrelated", "A", 2);
await operation(unrelated);
await sql("update manufacturing.requirements set part_location='On Robot' where id=$1", [old]);
const before = await row(old);
const beforeOp = await sql("select * from manufacturing.operations where id=$1", [op]);
const initialToken = await token(), request = crypto.randomUUID();
assert.deepEqual(await change(old, true, 0, initialToken, request), { requirementId: old, obsolete: true, obsoletionVersion: 1 });
// Transport retries return the first result even after the state has changed.
assert.deepEqual(await change(old, true, 0, initialToken, request), { requirementId: old, obsolete: true, obsoletionVersion: 1 });
assert.equal((await row(unrelated)).obsolete, false);
for (const key of ["status", "qc_outcome", "required_quantity", "active_in_bom", "part_location"]) assert.equal((await row(old))[key], before[key]);
assert.deepEqual(await sql("select * from manufacturing.operations where id=$1", [op]), beforeOp);
await assert.rejects(sql("update manufacturing.operations set completed_quantity=1 where id=$1", [op]), /obsolete/);
await assert.rejects(sql("update manufacturing.requirements set status='Ready' where id=$1", [old]), /obsolete/);
await sql("update manufacturing.requirements set production_notes='Quarantine',part_location='Shelf 1' where id=$1", [old]);
await assert.rejects(sql("update manufacturing.requirements set part_location='On Robot' where id=$1", [old]), /obsolete/);
await assert.rejects(change(old, false, 1, initialToken), /state changed/);
await change(old, false, 1);
await change(old, true, 2); // Undo restoration.
await assert.rejects(change(old, false, 1), /Obsoletion changed/);
await change(old, false, 3); // Undo marking obsolete.
await sql("update public.profiles set approved=false where id=$1", [actor]);
await assert.rejects(change(old, true, 4), /Approved actor/);
await sql("update public.profiles set approved=true where id=$1", [actor]);
await db.exec("update manufacturing.write_control set enabled=false");
await assert.rejects(change(old, true, 4), /disabled/);
await db.exec("update manufacturing.write_control set enabled=true");
assert.equal((await sql("select has_function_privilege('authenticated','public.manufacturing_set_requirement_obsolete(uuid,uuid,text,bigint,boolean,bigint)','execute') allowed"))[0].allowed, false);
assert.equal((await sql("select has_function_privilege('service_role','public.manufacturing_set_requirement_obsolete(uuid,uuid,text,bigint,boolean,bigint)','execute') allowed"))[0].allowed, true);

let runId = 0;
async function sync(replace, revision, status = "success", complete = true) {
  return db.transaction(async tx => {
    const q = async (s, p = []) => (await tx.query(s, p)).rows;
    const run = ++runId;
    await q("insert into manufacturing.engineering_sync_runs values($1,'running')", [run]);
    await q("update manufacturing.requirements set active_in_bom=false where id=$1", [replace]);
    await q("update manufacturing.operations set active_in_routing=false where requirement_id=$1", [replace]);
    const next = (await q(`insert into manufacturing.requirements(production_key,part_id,assembly_id,source_root,
      configuration,required_part_revision,source_assembly_revision,active_in_bom,required_quantity)
      values($1,1,1,'ROOT','default',$2,$2,true,2) returning id`, [`rev-${run}`, revision]))[0].id;
    if (complete) await q(`insert into manufacturing.operations(operation_key,requirement_id,operation_number,
      work_type,machine,active_in_routing) values($1,$2,'OP1','Manufacturing','Mill',true)`, [`${next}|OP1`, next]);
    await q("update manufacturing.engineering_sync_runs set status=$2 where id=$1", [run, status]);
    return next;
  });
}
const replacement = await sync(old, "B");
assert.equal((await row(old)).obsolete, true);
assert.equal((await row(old)).obsolete_replacement_id, replacement);
assert.equal((await row(old)).obsoletion_origin, "automatic");
assert.equal((await row(replacement)).obsolete, false);
assert.equal((await row(unrelated)).obsolete, false);
assert.equal((await sql("select completed_quantity from manufacturing.operations where requirement_id=$1", [replacement]))[0].completed_quantity, null);
await assert.rejects(change(old, false, 4), /Obsoletion changed/); // Sync invalidated old Undo.
await change(old, false, (await row(old)).obsoletion_version);
const restored = await row(old);
await db.exec("insert into manufacturing.engineering_sync_runs values(1000,'running'); update manufacturing.engineering_sync_runs set status='success' where id=1000");
assert.deepEqual(await row(old), restored);
const newest = await sync(replacement, "C");
assert.equal((await row(old)).obsolete, true);
assert.equal((await row(old)).obsolete_replacement_id, newest);
assert.equal((await row(replacement)).obsolete, true);

for (const status of ["failed", "partial"]) {
  const current = await sync(newest, status, status);
  assert.equal((await row(newest)).obsolete, false);
  await sql("update manufacturing.requirements set active_in_bom=false where id=$1", [current]);
  await sql("update manufacturing.requirements set active_in_bom=true where id=$1", [newest]);
}
await sync(newest, "D", "success", false);
assert.equal((await row(newest)).obsolete, false, "Incomplete replacement cannot obsolete old work");
// A subsequent sync must neither unstop a manual requirement nor initialize new work on it.
await change(unrelated, true, 0);
await db.transaction(async tx => {
  await tx.exec("insert into manufacturing.engineering_sync_runs values(1001,'running')");
  await tx.query(`insert into manufacturing.operations(operation_key,requirement_id,operation_number,work_type,machine,active_in_routing)
    values('manually-stopped|OP2',$1,'OP2','Manufacturing','Mill',true)`, [unrelated]);
  await tx.exec("update manufacturing.engineering_sync_runs set status='success' where id=1001");
});
assert.equal((await row(unrelated)).obsolete, true);
assert.equal((await sql("select status from manufacturing.operations where operation_key='manually-stopped|OP2'"))[0].status, null);
assert.ok((await sql("select count(*)::int count from manufacturing.obsoletion_history"))[0].count >= 7);
await assert.rejects(db.exec("delete from manufacturing.obsoletion_history"), /append only/);
await db.close();
console.log("Obsoletion PostgreSQL checks passed: permissions, history, work guards, Undo/CAS, sync scope, restoration, failed/partial/incomplete sync.");
