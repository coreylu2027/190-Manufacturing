// In-memory PostgreSQL only. No HTTP, Onshape, Supabase or backend credentials.
// npm run onshape:test-sql
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const sql = async (text, values = []) => (await db.query(text, values)).rows;
const read = path => readFile(new URL(path, import.meta.url), 'utf8');
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema frc190_baserow_stage;
  create table frc190_baserow_stage.snapshots(id uuid primary key);
  create schema storage;
  create table storage.buckets(id text primary key, public boolean not null);
  create table storage.objects(bucket_id text, name text);
  insert into storage.buckets values('manufacturing-files',false);
`);
await db.exec(await read('./fixtures/contract-normalized.sql'));
await db.exec(await read('./fixtures/contract-attachments.sql'));
await db.exec(await read('../../../supabase/production/20260906_onshape_engineering_sync.sql'));
await db.exec(await read('../../../supabase/migrations/20260906143937_preserve_cam_operations.sql'));
await db.exec(await read('../../../supabase/production/20260910_preserve_unchanged_part_revisions.sql'));
await db.exec(await read('../../../supabase/migrations/20260926000000_cots_parts.sql'));
// Reapplying the patch is a no-op.
await db.exec(await read('../../../supabase/migrations/20260926000000_cots_parts.sql'));

const begin = async () => {
  const id = randomUUID();
  await sql('select public.manufacturing_begin_engineering_sync($1,$2)', [id, 'https://example.test/run']);
  return id;
};
const apply = async (payload, id) =>
  (await sql('select public.manufacturing_apply_engineering_sync($1,$2) result', [id || await begin(), payload]))[0].result;
const snapshot = async () => {
  const data = {};
  for (const table of ['assemblies','parts','requirements','operations','finishing','attachments'])
    data[table] = await sql(`select * from manufacturing.${table} order by id`);
  return data;
};
function payload(root = 'A-ONE', revision = 'A', partRevision = 'A') {
  const key = `${root}|${partRevision}|${root}|P-ONE|default|v2`;
  return {
    assemblies: [{assembly_number:root,subsystem_name:'Subsystem',active:true,
      sync_schema_version:'supabase-engineering-v2',latest_released_revision:revision,
      discovery_master:'https://example.test/master',integration_status:'Discovered — Master Unreleased'}],
    parts: [{part_number:'P-ONE',name:'Plate',revision:partRevision,active:true}],
    requirements: [{production_key:key,part_number:'P-ONE',assembly_number:root,
      source_root:root,source_assembly_revision:revision,required_part_revision:partRevision,
      configuration:'default',required_quantity:4,finishing:'Red',machine_op1:'Haas CNC',active_in_bom:true}],
    operations: [{operation_key:`${key}|OP1`,production_key:key,operation_number:'OP1',
      machine:'Haas CNC',work_type:'Manufacturing',active_in_routing:true}],
    finishing: [{production_key:key,color:'Red',required_quantity:4,active:true}],
    attachments: [], synced_roots:[root],discovered_roots:[root],discovery_master:'',
    discovery_complete:true,cad_synced:false,warnings:[],source_rows:1,file_groups_cached:0,
  };
}

// Exercise the API using its actual restricted role.
await db.exec('set role service_role');
await assert.rejects(sql('select * from manufacturing.parts'), /permission denied/);
const first = payload();
const initialResult = await apply(first);
assert.equal(initialResult.status, 'success', JSON.stringify(initialResult));
await db.exec('reset role');
const created = await snapshot();
assert.equal(created.requirements[0].part_id, created.parts[0].id);
assert.equal(created.requirements[0].assembly_id, created.assemblies[0].id);
assert.equal(created.operations[0].requirement_id, created.requirements[0].id);
assert.equal(created.finishing[0].requirement_id, created.requirements[0].id);

// Seed every shop-owned column from model.ts, plus normalized location fields.
const model = await read('./fixtures/contract-model.ts');
const shopByTable = {};
for (const section of model.split('{ name: ').slice(1)) {
  const match = section.match(/^"(\w+)"/);
  if (!match) continue;
  const table = match[1];
  shopByTable[table] = [...section.matchAll(/\["(\w+)","[^"]+","(\w+)","shop"\]/g)]
    .map(([, name, kind]) => [name, kind]);
}
await db.exec("insert into manufacturing.locations(location_key,name) values('L','Shelf')");
for (const [table, fields] of Object.entries(shopByTable)) {
  for (const [name, kind] of fields) {
    const value = kind === 'number' ? 7 : kind === 'date' ? '2026-09-01T00:00:00Z' : 'Shop-owned sentinel';
    await sql(`update manufacturing.${table} set ${name}=$1`, [value]);
  }
  await db.exec(`update manufacturing.${table} set location_id=1`);
}
await db.exec(`update manufacturing.requirements set part_location='On Robot',
  location_updated_by='shop-user',location_updated_at='2026-09-01T00:00:00Z'`);
await db.exec(`insert into manufacturing.operation_allocations
  select id,1,'shop-user','Shop',4,2,'{"untouched":true}' from manufacturing.operations`);
const shopBefore = await snapshot();
const allocations = await sql('select * from manufacturing.operation_allocations');
first.parts[0].name = 'Revised engineering name';
first.requirements[0].required_quantity = 9;
first.finishing[0].required_quantity = 9;
assert.equal((await apply(first)).status, 'success');
const shopAfter = await snapshot();
for (const [table, fields] of Object.entries(shopByTable)) {
  for (const name of [...fields.map(([name])=>name),'location_id',
    ...(table === 'requirements' ? ['part_location','location_updated_by','location_updated_at'] : [])])
    assert.deepEqual(shopAfter[table][0][name], shopBefore[table][0][name], `${table}.${name}`);
}
assert.deepEqual(await sql('select * from manufacturing.operation_allocations'), allocations);
assert.equal(shopAfter.requirements[0].engineering_changed,true);
assert.equal(shopAfter.parts[0].name,'Revised engineering name');

// Every shop column is rejected by the server as well as omitted by the client.
for (const [table, fields] of Object.entries(shopByTable)) {
  for (const [field] of fields) {
    const bad = structuredClone(first); bad[table][0][field]='forbidden';
    const before=await snapshot();
    assert.equal((await apply(bad)).status,'failed', `${table}.${field}`);
    assert.deepEqual(await snapshot(),before);
  }
}

// A late FK failure must roll back earlier assembly/part upserts, including markers.
let bad=structuredClone(first);
bad.parts[0].name='MUST ROLL BACK';
bad.operations[0].production_key='missing';
let before=await snapshot();
assert.equal((await apply(bad)).status,'failed');
assert.deepEqual(await snapshot(),before);
assert.equal((await sql("select status from manufacturing.engineering_sync_runs order by started_at desc limit 1"))[0].status,'failed');

// A parent assembly revision change with the same required part revision keeps
// the exact requirement/work rows and all shop-owned state.
assert.equal((await apply(payload('A-TWO'))).status,'success');
const secondRootBefore = (await snapshot());
const next=payload('A-ONE','B');
next.warnings=['A-TWO could not be synced and was skipped'];
next.discovery_complete=false;
next.discovery_master='https://example.test/master';
assert.equal((await apply(next)).status,'partial');
const scoped=await snapshot();
const preservedRequirement=scoped.requirements.find(r=>r.production_key===first.requirements[0].production_key);
const beforeRequirement=secondRootBefore.requirements.find(r=>r.production_key===first.requirements[0].production_key);
assert.equal(preservedRequirement.id,beforeRequirement.id);
assert.equal(preservedRequirement.active_in_bom,true);
assert.equal(preservedRequirement.source_assembly_revision,'B');
assert.equal(scoped.requirements.filter(r=>r.source_root==='A-ONE').length,1);
assert.equal(scoped.operations.find(o=>o.requirement_id===preservedRequirement.id).id,
  secondRootBefore.operations.find(o=>o.requirement_id===beforeRequirement.id).id);
assert.equal(scoped.finishing.find(f=>f.requirement_id===preservedRequirement.id).id,
  secondRootBefore.finishing.find(f=>f.requirement_id===beforeRequirement.id).id);
for (const table of ['requirements','operations','finishing']) {
  const fields=shopByTable[table];
  const beforeRow=secondRootBefore[table].find(row =>
    table==='requirements' ? row.id===beforeRequirement.id : row.requirement_id===beforeRequirement.id);
  const afterRow=scoped[table].find(row =>
    table==='requirements' ? row.id===preservedRequirement.id : row.requirement_id===preservedRequirement.id);
  for (const name of fields.map(([name])=>name))
    assert.deepEqual(afterRow[name],beforeRow[name],`${table}.${name} after parent revision`);
}
for (const table of ['requirements','operations','finishing']) {
  const other = secondRootBefore[table].at(-1);
  assert.deepEqual(scoped[table].find(r=>r.id===other.id),other);
}
assert.equal(scoped.assemblies.find(a=>a.assembly_number==='A-TWO').integration_status,'Discovered — Master Unreleased');

// The first v2 run also re-keys a legacy parent-revision key in place when the
// required part revision is unchanged.
await db.exec(`
  insert into manufacturing.assemblies(assembly_number,latest_released_revision,sync_schema_version)
    values('A-LEGACY','A','supabase-engineering-v1');
  insert into manufacturing.requirements(production_key,part_id,assembly_id,configuration,
    required_quantity,source_root,source_assembly_revision,required_part_revision,active_in_bom,status)
    select 'A-LEGACY|A|A-LEGACY|P-ONE|default',p.id,a.id,'default',4,
      'A-LEGACY','A','B',true,'In Progress'
    from manufacturing.parts p cross join manufacturing.assemblies a
    where p.part_number='P-ONE' and a.assembly_number='A-LEGACY';
  insert into manufacturing.operations(operation_key,requirement_id,operation_number,machine,
    work_type,active_in_routing,status,claimed_quantity)
    select production_key||'|OP1',id,'OP1','Haas CNC','Manufacturing',true,'In Progress',2
    from manufacturing.requirements where source_root='A-LEGACY';
  insert into manufacturing.finishing(production_key,requirement_id,color,required_quantity,active,machinist)
    select production_key,id,'Red',4,true,'Legacy finisher'
    from manufacturing.requirements where source_root='A-LEGACY';
`);
const legacyBefore=(await snapshot());
const legacyRequirement=legacyBefore.requirements.find(r=>r.source_root==='A-LEGACY');
assert.equal((await apply(payload('A-LEGACY','B','B'))).status,'success');
const legacyAfter=await snapshot();
const rekeyed=legacyAfter.requirements.find(r=>r.source_root==='A-LEGACY' && r.active_in_bom);
assert.equal(rekeyed.id,legacyRequirement.id);
assert.equal(rekeyed.production_key,'A-LEGACY|B|A-LEGACY|P-ONE|default|v2');
assert.equal(rekeyed.status,'In Progress');
assert.equal(Number(legacyAfter.operations.find(o=>o.requirement_id===rekeyed.id).claimed_quantity),2);
assert.equal(legacyAfter.finishing.find(f=>f.requirement_id===rekeyed.id).machinist,'Legacy finisher');

// An actual required part revision change intentionally creates a new work row
// and retires the prior revision.
const revisionA=payload('A-REVISION','A','A');
assert.equal((await apply(revisionA)).status,'success');
const revisionAId=(await snapshot()).requirements.find(r=>r.source_root==='A-REVISION').id;
const revisionB=payload('A-REVISION','B','B');
assert.equal((await apply(revisionB)).status,'success');
const revisionRows=(await snapshot()).requirements.filter(r=>r.source_root==='A-REVISION');
assert.equal(revisionRows.length,2);
assert.equal(revisionRows.find(r=>r.id===revisionAId).active_in_bom,false);
assert.notEqual(revisionRows.find(r=>r.active_in_bom).id,revisionAId);

// Membership-only reconciliation never mutates work, even for a missing root.
const membership=payload();
for (const table of ['assemblies','parts','requirements','operations','finishing']) membership[table]=[];
membership.synced_roots=[];
membership.discovered_roots=['A-ONE'];
membership.discovery_master='https://example.test/master';
let workBefore=await snapshot();
assert.equal((await apply(membership)).status,'success');
let workAfter=await snapshot();
for (const table of ['parts','requirements','operations','finishing','attachments'])
  assert.deepEqual(workAfter[table],workBefore[table]);
assert.equal(workAfter.assemblies.find(a=>a.assembly_number==='A-TWO').integration_status,'Missing from Main — Review');
membership.discovered_roots=['A-ONE','A-TWO'];
assert.equal((await apply(membership)).status,'success');
assert.equal((await snapshot()).assemblies.find(a=>a.assembly_number==='A-TWO').integration_status,'Discovered — Master Unreleased');

// Empty released BOM legitimately deactivates the successful root's prior work.
await sql(`insert into manufacturing.operations(operation_key,requirement_id,work_type,active_in_routing,claimed_quantity,completed_quantity)
  select production_key||'|CAM|OP1',id,'CAM',true,2,1 from manufacturing.requirements where source_root='A-ONE'`);
const camBefore = await sql("select * from manufacturing.operations where work_type='CAM' order by id");
assert.ok(camBefore.length > 0);
const empty=payload('A-ONE','C');
for (const table of ['parts','requirements','operations','finishing']) empty[table]=[];
assert.equal((await apply(empty)).status,'success');
assert.deepEqual(await sql("select * from manufacturing.operations where work_type='CAM' order by id"),camBefore);
assert.equal((await sql(`select count(*)::int n from manufacturing.operations o join manufacturing.requirements r on r.id=o.requirement_id
  where r.source_root='A-ONE' and o.work_type='Manufacturing' and o.active_in_routing`))[0].n,0);
assert.equal((await sql("select count(*)::int n from manufacturing.requirements where source_root='A-ONE' and active_in_bom"))[0].n,0);
bad=structuredClone(empty);bad.synced_roots=[];
assert.equal((await apply(bad)).status,'failed');

// Private attachment registration, replacement, retries and truncating obsolete positions.
const withFiles=payload('A-ONE','D');
const file = digit => ({original_name:'plate.step',content_type:'application/step',byte_size:4,
  sha256:digit.repeat(64),storage_bucket:'manufacturing-files',storage_path:`sha256/${digit.repeat(2)}/${digit.repeat(64)}.step`,
  source_url:`https://cad.onshape.com/export/${digit}`,source_metadata:{export_key:digit},verified_at:'2026-09-06T00:00:00Z'});
for (const digit of ['a','b','c']) await sql('insert into storage.objects values($1,$2)', ['manufacturing-files',file(digit).storage_path]);
withFiles.attachments=[{part_number:'P-ONE',kind:'step',export_key:'a'.repeat(64),files:[file('a'),file('b')]}];
withFiles.cad_synced=true;
assert.equal((await apply(withFiles)).status,'success');
const attachmentIds=(await snapshot()).attachments.map(a=>a.id);
assert.equal((await apply(withFiles)).status,'success');
assert.deepEqual((await snapshot()).attachments.map(a=>a.id),attachmentIds);
withFiles.attachments[0]={part_number:'P-ONE',kind:'step',export_key:'c'.repeat(64),files:[file('c')]};
assert.equal((await apply(withFiles)).status,'success');
assert.equal((await snapshot()).attachments.length,1);
assert.equal((await snapshot()).attachments[0].sha256,'c'.repeat(64));
const apiFile=(await sql("select public.manufacturing_file_for_requirement($1,'step') result",[(await snapshot()).requirements.at(-1).id]))[0].result;
assert.equal(apiFile.path,file('c').storage_path);
bad=structuredClone(withFiles);bad.attachments[0].files[0].storage_path='wrong';
before=await snapshot();assert.equal((await apply(bad)).status,'failed');assert.deepEqual(await snapshot(),before);
await db.exec("update storage.buckets set public=true");
assert.equal((await apply(withFiles)).status,'failed');
await db.exec("update storage.buckets set public=false");

// Retrying an acknowledged or uncertain commit is idempotent; an older run cannot overwrite it.
const older=await begin(), newer=await begin();
assert.equal((await apply(withFiles,newer)).status,'success');
before=await snapshot();
assert.equal((await apply(withFiles,newer)).status,'success');
await sql("select public.manufacturing_finish_engineering_sync($1,'failed','{}')",[newer]);
assert.equal((await sql('select status from manufacturing.engineering_sync_runs where id=$1',[newer]))[0].status,'success');
assert.equal((await apply(withFiles,older)).status,'failed');
assert.deepEqual(await snapshot(),before);

// COTS parts are engineering-owned, carry no routing, and older payloads default to made parts.
const cots=structuredClone(withFiles);
const cotsKey=`${cots.synced_roots[0]}|A|${cots.synced_roots[0]}|WCP-0215|default|v2`;
cots.attachments=[];
cots.parts.push({part_number:'WCP-0215',name:'Bearing',revision:'A',active:true,cots:true});
cots.requirements.push({production_key:cotsKey,part_number:'WCP-0215',assembly_number:cots.synced_roots[0],
  source_root:cots.synced_roots[0],source_assembly_revision:cots.requirements[0].source_assembly_revision,
  required_part_revision:'A',configuration:'default',required_quantity:6,finishing:'None',active_in_bom:true});
assert.equal((await apply(cots)).status,'success');
let partRows=await sql("select part_number,cots from manufacturing.parts order by id");
assert.equal(partRows.find(row=>row.part_number==='WCP-0215').cots,true);
assert.equal(partRows.find(row=>row.part_number==='P-ONE').cots,false);
const cotsRequirement=(await sql('select id,required_quantity from manufacturing.requirements where production_key=$1',[cotsKey]))[0];
assert.equal(Number(cotsRequirement.required_quantity),6);
assert.equal((await sql('select count(*)::int n from manufacturing.operations where requirement_id=$1',[cotsRequirement.id]))[0].n,0);
// Omitting the flag keeps it; a new part without it defaults to made.
const withoutFlag=structuredClone(cots);
withoutFlag.parts=withoutFlag.parts.map(({cots:_,...part})=>part);
withoutFlag.parts.push({part_number:'P-NEW',name:'New',revision:'A',active:true});
assert.equal((await apply(withoutFlag)).status,'success');
partRows=await sql("select part_number,cots from manufacturing.parts order by id");
assert.equal(partRows.find(row=>row.part_number==='WCP-0215').cots,true);
assert.equal(partRows.find(row=>row.part_number==='P-NEW').cots,false);
bad=structuredClone(cots);bad.parts.at(-1).cots='maybe';
before=await snapshot();assert.equal((await apply(bad)).status,'failed');assert.deepEqual(await snapshot(),before);

for (const role of ['anon','authenticated']) {
  await db.exec(`set role ${role}`);
  await assert.rejects(sql('select public.manufacturing_engineering_sync_state()'), /permission denied/);
  await assert.rejects(sql('select public.manufacturing_apply_engineering_sync($1,$2)',[randomUUID(),first]), /permission denied/);
  await db.exec('reset role');
}
await db.close();
console.log('PASS: exact contract migration, relationships, all shop fields, scoped deactivation, rollback, attachments, retries, concurrency and grants');
