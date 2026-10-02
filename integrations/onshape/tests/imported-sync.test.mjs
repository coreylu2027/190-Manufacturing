// Regression for the read-only production preflight: imported duplicate operation
// keys and empty normalized revision fields. All data below is synthetic.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const {PGlite}=await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db=new PGlite();
const query=async (q,p=[]) => (await db.query(q,p)).rows;
const read=p=>readFile(new URL(p,import.meta.url),'utf8');
await db.exec(`create role anon;create role authenticated;create role service_role;
  create schema frc190_baserow_stage;
  create table frc190_baserow_stage.snapshots(id uuid primary key);
  create schema storage;
  create table storage.buckets(id text primary key, public boolean not null);
  create table storage.objects(bucket_id text,name text);`);
await db.exec(await read('./fixtures/contract-normalized.sql'));
await db.exec(await read('./fixtures/contract-attachments.sql'));
await db.exec(`
  insert into manufacturing.assemblies(assembly_number,sync_schema_version) values('A-IMPORTED','source-document-v1');
  insert into manufacturing.parts(part_number,name,revision,step_export_key) values('P-IMPORTED','Plate','B','previous-export');
  insert into manufacturing.requirements(production_key,part_id,assembly_id,required_quantity,active_in_bom,status)
    select 'A-IMPORTED|A|A-IMPORTED|P-IMPORTED|default',p.id,a.id,4,true,'In Progress'
    from manufacturing.parts p cross join manufacturing.assemblies a;
  insert into manufacturing.operations(operation_key,requirement_id,operation_number,machine,work_type,
    active_in_routing,status,claimed_quantity,completed_quantity,quantity_ledger)
    select r.production_key||'|OP1',r.id,'OP1','Haas CNC','Manufacturing',true,
      case n when 1 then 'In Progress' else 'Complete' end,n,2*n,'separate ledger '||n
    from manufacturing.requirements r cross join generate_series(1,2) n;
  insert into manufacturing.operation_allocations(operation_id,ordinal,user_id,display_name,claimed,completed,source_allocation)
    select id,1,'test-user-'||id,'Synthetic user',claimed_quantity,completed_quantity,'{}'
    from manufacturing.operations;
`);
// The migration must preserve duplicate rows while re-keying legacy identity in place.
const before=await query('select * from manufacturing.operations order by id');
const allocations=await query('select * from manufacturing.operation_allocations order by operation_id');
await db.exec(await read('../../../supabase/production/20260906_onshape_engineering_sync.sql'));
await db.exec(await read('../../../supabase/migrations/20260906143937_preserve_cam_operations.sql'));
await db.exec(await read('../../../supabase/production/20260910_preserve_unchanged_part_revisions.sql'));
assert.deepEqual(await query('select * from manufacturing.operations order by id'),before);
const key='A-IMPORTED|B|A-IMPORTED|P-IMPORTED|default|v2';
const payload={
  assemblies:[{assembly_number:'A-IMPORTED',latest_released_revision:'B',sync_schema_version:'supabase-engineering-v2',active:true}],
  parts:[{part_number:'P-IMPORTED',name:'Plate',revision:'B',active:true}],
  requirements:[{production_key:key,part_number:'P-IMPORTED',assembly_number:'A-IMPORTED',source_root:'A-IMPORTED',
    source_assembly_revision:'B',required_part_revision:'B',configuration:'default',required_quantity:4,active_in_bom:true}],
  operations:[{operation_key:key+'|OP1',production_key:key,operation_number:'OP1',machine:'Haas CNC',work_type:'Manufacturing',active_in_routing:true}],
  finishing:[],attachments:[],warnings:[],synced_roots:['A-IMPORTED'],discovered_roots:['A-IMPORTED'],
  discovery_master:'',discovery_complete:true,cad_synced:false,source_rows:1,file_groups_cached:0,
};
const apply=async p=>{
  const id=randomUUID();
  await query("select public.manufacturing_begin_engineering_sync($1,'local-test')",[id]);
  return (await query('select public.manufacturing_apply_engineering_sync($1,$2) result',[id,p]))[0].result;
};
const shopFields=['id','status','machinist','started_at','completed_at','claimed_quantity','completed_quantity',
  'quantity_ledger','cam_program_path','cam_notes','location_id'];
for(let pass=0;pass<2;pass++) {
  const result=await apply(payload);
  assert.equal(result.status,'partial',JSON.stringify(result));
  assert.equal(result.duplicate_operations_preserved,1);
  const after=await query('select * from manufacturing.operations order by id');
  assert.equal(after.length,2);
  for(let i=0;i<2;i++) for(const f of shopFields) assert.deepEqual(after[i][f],before[i][f],f);
  assert.deepEqual(await query('select * from manufacturing.operation_allocations order by operation_id'),allocations);
  const req=await query('select * from manufacturing.requirements');
  assert.equal(req.length,1);assert.equal(req[0].source_root,'A-IMPORTED');assert.equal(req[0].status,'In Progress');
  assert.equal((await query('select step_export_key from manufacturing.parts'))[0].step_export_key,'previous-export');
}
const state=(await query('select public.manufacturing_engineering_sync_state() result'))[0].result;
assert.equal(state[0]['Latest Released Revision'],'B');
assert.equal(state[0]['Sync Schema Version'],'supabase-engineering-v2');
assert.equal(state[0]['CAD Synced'],false);

// A key collision pointing at different shop work must roll the whole sync back.
await db.exec("update manufacturing.operations set work_type='CAM' where id=(select max(id) from manufacturing.operations)");
const partsBefore=await query('select * from manufacturing.parts');
const opsBefore=await query('select * from manufacturing.operations order by id');
const bad=structuredClone(payload);bad.parts[0].name='must roll back';
assert.equal((await apply(bad)).status,'failed');
assert.deepEqual(await query('select * from manufacturing.parts'),partsBefore);
assert.deepEqual(await query('select * from manufacturing.operations order by id'),opsBefore);
await db.close();
console.log('PASS: imported duplicates survive migration/replay, shop allocations stay intact, missing revision fields are populated, conflicting work rolls back');
