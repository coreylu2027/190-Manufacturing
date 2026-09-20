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
  create function auth.uid() returns uuid language sql as 'select null::uuid';
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
await install("supabase/migrations/202609010003_notifications.sql");
await install("supabase/migrations/20260919030147_obsolete_work_notifications.sql");
await install("supabase/migrations/20260919222149_obsolete_removed_requirements.sql");
await install("supabase/migrations/20260919223625_hide_obsolete_requirements.sql");
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
// Real alerts use the same inbox table and retain claims even after routing deactivation.
const worker = "00000000-0000-4000-8000-000000000191";
await sql("insert into auth.users values($1)",[worker]);
await sql("insert into public.profiles values($1,'Blake B.',true,'machinist')",[worker]);
const notifyReq = await requirement("notify", "N");
const notifyOp = await operation(notifyReq);
const ledger = JSON.stringify([{userId:actor,name:'Alex A.',claimed:1,completed:1},{userId:worker,name:'Blake B.',claimed:1,completed:0}]);
await sql("update manufacturing.operations set status='In Progress',claimed_quantity=2,quantity_ledger=$2 where id=$1",[notifyOp,ledger]);
await sql("insert into manufacturing.operations(operation_key,requirement_id,operation_number,work_type,status,quantity_ledger) values('notify-cam',$1,'OP1','CAM','In Progress',$2)",[notifyReq,ledger]);
const notifications = async id => sql("select * from public.notifications where data->>'requirementId'=$1 order by recipient_id",[String(id)]);
const notifyToken = await token(), notifyRequest = crypto.randomUUID();
await change(notifyReq,true,0,notifyToken,notifyRequest);
assert.equal((await notifications(notifyReq)).length,2,'deduplicate a user across CAM and manufacturing');
assert.match((await notifications(notifyReq))[0].message,/Stop work. Do not manufacture or install/);
assert.equal((await notifications(notifyReq))[0].email_status,'pending');
await change(notifyReq,true,0,notifyToken,notifyRequest);
assert.equal((await notifications(notifyReq)).length,2,'transport retry must not notify twice');
await change(notifyReq,false,1);
assert.equal((await notifications(notifyReq)).length,2,'restoration is not a stop-work alert');
await change(notifyReq,true,2);
assert.equal((await notifications(notifyReq)).length,4,'Undo restoration is a new stop-work event');
assert.equal((await sql("select quantity_ledger from manufacturing.operations where id=$1",[notifyOp]))[0].quantity_ledger,ledger);
// Completed-only allocations are not affected recipients; unique legacy names resolve.
const legacyReq = await requirement('legacy-notify','L');
const legacyOp = await operation(legacyReq);
await sql("update manufacturing.operations set status='In Progress',claimed_quantity=1,machinist='Blake B.' where id=$1",[legacyOp]);
await change(legacyReq,true,0);
assert.deepEqual((await notifications(legacyReq)).map(n=>n.recipient_id),[worker]);
const ambiguousReq = await requirement('ambiguous-notify','L');
const ambiguousOp = await operation(ambiguousReq);
await sql("update public.profiles set display_name='Blake B.' where id=$1",[actor]);
await sql("update manufacturing.operations set status='In Progress',claimed_quantity=1,machinist='Blake B.',quantity_ledger='invalid' where id=$1",[ambiguousOp]);
await change(ambiguousReq,true,0);
assert.equal((await notifications(ambiguousReq)).length,0,'malformed legacy data must not block obsoletion or guess recipients');
await sql("update public.profiles set display_name='Alex A.' where id=$1",[actor]);
assert.equal((await notifications(old)).length,0,'completed-only work gets no stop-work alert');
// Sync deactivates routing before the transition; its remaining claims still notify.
await sql("update manufacturing.requirements set active_in_bom=false where active_in_bom and assembly_id=1");
const syncReq = await requirement('sync-notify','X');
const syncOp = await operation(syncReq);
await sql("update manufacturing.operations set status='In Progress',claimed_quantity=2,quantity_ledger=$2 where id=$1",[syncOp,ledger]);
await sync(syncReq,'Y');
assert.equal((await notifications(syncReq)).length,2);
assert.equal((await notifications(syncReq))[0].data.origin,'automatic');
await db.exec("insert into manufacturing.engineering_sync_runs values(2000,'running'); update manufacturing.engineering_sync_runs set status='success' where id=2000");
assert.equal((await notifications(syncReq)).length,2,'repeated sync does not duplicate alerts');
await sql("update manufacturing.requirements set obsolete_replacement_id=null,obsoletion_version=obsoletion_version+1 where id=$1",[syncReq]);
assert.equal((await notifications(syncReq)).length,2,'already-obsolete metadata changes must not alert again');
// Transaction rollback also rolls back notifications.
const rollbackReq = await requirement('rollback-notify','Z');
const rollbackOp = await operation(rollbackReq);
await sql("update manufacturing.operations set status='In Progress',quantity_ledger=$2 where id=$1",[rollbackOp,ledger]);
await assert.rejects(db.transaction(async tx=>{await tx.query("update manufacturing.requirements set obsolete=true where id=$1",[rollbackReq]);throw new Error('rollback');}),/rollback/);
assert.equal((await notifications(rollbackReq)).length,0);
assert.equal((await sql("select has_function_privilege('authenticated','manufacturing.notify_obsolete_work()','execute') allowed"))[0].allowed,false);
// Successful removals without a replacement stop work and notify claimants.
const removed = await requirement('removed','R',2);
await sql("update manufacturing.requirements set configuration='removal-test',part_location='On Robot' where id=$1",[removed]);
const removedOp = await operation(removed);
await sql("update manufacturing.operations set status='In Progress',claimed_quantity=2,quantity_ledger=$2 where id=$1",[removedOp,ledger]);
const originalRemovedOp = await sql("select quantity_ledger,completed_quantity from manufacturing.operations where id=$1",[removedOp]);
async function removeInSync(id,status) {
  await db.transaction(async tx=>{
    const run=++runId;
    await tx.query("insert into manufacturing.engineering_sync_runs values($1,'running')",[run]);
    await tx.query("update manufacturing.requirements set active_in_bom=false where id=$1",[id]);
    await tx.query("update manufacturing.operations set active_in_routing=false where requirement_id=$1",[id]);
    await tx.query("update manufacturing.engineering_sync_runs set status=$2 where id=$1",[run,status]);
  });
}
for(const status of ['failed','partial']) {
  await removeInSync(removed,status);
  assert.equal((await row(removed)).obsolete,false);
  assert.equal((await notifications(removed)).length,0);
  await sql("update manufacturing.requirements set active_in_bom=true where id=$1",[removed]);
}
await removeInSync(removed,'success');
assert.equal((await row(removed)).obsolete,true);
assert.equal((await row(removed)).obsolete_replacement_id,null);
assert.equal((await row(removed)).obsoletion_origin,'automatic');
assert.equal((await row(removed)).part_location,'On Robot');
assert.equal((await row(removed)).qc_outcome,'Passed');
assert.deepEqual(await sql("select quantity_ledger,completed_quantity from manufacturing.operations where id=$1",[removedOp]),originalRemovedOp);
assert.equal((await notifications(removed)).length,2);
const removalVersion=(await row(removed)).obsoletion_version;
await removeInSync(removed,'success');
assert.equal((await row(removed)).obsoletion_version,removalVersion);
assert.equal((await notifications(removed)).length,2);
await change(removed,false,removalVersion);
await removeInSync(removed,'success');
assert.equal((await row(removed)).obsolete,false,'unchanged sync preserves explicit restoration');
// Reactivating then removing again is a new removal, which can stop work again.
await sql("update manufacturing.requirements set active_in_bom=true where id=$1",[removed]);
await removeInSync(removed,'success');
assert.equal((await row(removed)).obsolete,true);
assert.equal((await notifications(removed)).length,4);
const manuallyStopped=await requirement('manual-removal','M',2);
await change(manuallyStopped,true,0);
const manualBefore=await row(manuallyStopped);
await removeInSync(manuallyStopped,'success');
assert.equal((await row(manuallyStopped)).obsoletion_version,manualBefore.obsoletion_version);
assert.equal((await row(manuallyStopped)).obsoletion_origin,'manual');
assert.equal((await row(rollbackReq)).obsolete,false,'unrelated active work is untouched');
// Hiding is an admin-only, reversible list preference on obsolete requirements.
const hide = async (id, hidden, version, request=crypto.randomUUID(), expected=null) => (await sql(
  'select public.manufacturing_set_requirement_hidden($1,$2,$3,$4,$5,$6) result',
  [request,actor,expected ?? await token(),id,hidden,version]))[0].result;
await assert.rejects(hide(manuallyStopped,true,0),/administrator/);
await sql("update public.profiles set role='admin' where id=$1",[actor]);
await sql("update public.profiles set approved=false where id=$1",[actor]);
await assert.rejects(hide(manuallyStopped,true,0),/administrator/);
await sql("update public.profiles set approved=true where id=$1",[actor]);
await assert.rejects(hide(rollbackReq,true,0),/Only obsolete/);
const beforeHide=await row(manuallyStopped);
const hideRequest=crypto.randomUUID(),hideToken=await token();
const hiddenResult=await hide(manuallyStopped,true,0,hideRequest,hideToken);
assert.equal(hiddenResult.hidden,true);
assert.equal(hiddenResult.visibilityVersion,1);
assert.deepEqual(await hide(manuallyStopped,true,0,hideRequest,hideToken),hiddenResult);
for(const key of ['obsolete','obsoletion_version','status','qc_outcome','required_quantity','active_in_bom']) assert.equal((await row(manuallyStopped))[key],beforeHide[key]);
assert.equal((await row(manuallyStopped)).visibility_changed_by,'Alex A.');
assert.equal((await sql("select count(*)::int count from manufacturing.write_history where request_id=$1",[hideRequest]))[0].count,1);
await assert.rejects(hide(manuallyStopped,false,0),/Visibility changed/);
await hide(manuallyStopped,false,1);
assert.equal((await row(manuallyStopped)).hidden,false);
await hide(manuallyStopped,true,2); // Undo unhide.
await assert.rejects(hide(manuallyStopped,false,3,crypto.randomUUID(),hideToken),/state changed/);
await change(manuallyStopped,false,(await row(manuallyStopped)).obsoletion_version);
assert.equal((await row(manuallyStopped)).hidden,false,'restoring obsolete work makes it visible');
assert.equal((await row(manuallyStopped)).visibility_version,4);
await assert.rejects(hide(manuallyStopped,true,3),/Visibility changed/);
await assert.rejects(sql("update manufacturing.requirements set hidden=true where id=$1",[manuallyStopped]),/hidden_requirements_are_obsolete/);
assert.equal((await sql("select has_function_privilege('authenticated','public.manufacturing_set_requirement_hidden(uuid,uuid,text,bigint,boolean,bigint)','execute') allowed"))[0].allowed,false);
assert.equal((await sql("select has_function_privilege('service_role','public.manufacturing_set_requirement_hidden(uuid,uuid,text,bigint,boolean,bigint)','execute') allowed"))[0].allowed,true);
await db.close();
console.log("Obsoletion PostgreSQL checks passed: permissions, history, work guards, Undo/CAS, sync scope, restoration, failed/partial/incomplete sync.");
