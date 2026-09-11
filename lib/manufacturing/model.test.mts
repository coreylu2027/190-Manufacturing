import test from "node:test";
import assert from "node:assert/strict";
import {ENTITIES,normalizeRow,denormalizeRow,type NormalizedRow} from "./model.ts";
import {manufacturingSupabaseConfig} from "./config.ts";
import {compareRows} from "./parity.ts";
import {createSupabaseManufacturingAdapter} from "./supabase-adapter.ts";
test("normalized rows preserve original claims, keys, nulls, select metadata and timestamp precision",()=>{
 const entity=ENTITIES.find(e=>e.name==="operations")!;
 const raw={id:42,Operation:"root|part|OP1",Status:{id:7,value:"In Progress",color:"blue"},
 "Started At":"2026-08-31T00:01:02.123456Z","Completed At":null,"Claimed Quantity":"3",
 "Quantity Ledger":'[{"userId":"legacy:A","name":"A","claimed":3,"completed":0}]',"Production Requirement":[{id:1,value:"Part — Name [Assembly]"}]};
 const row=normalizeRow(entity,raw) as NormalizedRow;
 assert.deepEqual(denormalizeRow(entity,row),raw);
 row.status="Complete";
 assert.equal((denormalizeRow(entity,row).Status as {value:string}).value,"Complete");
 assert.equal(denormalizeRow(entity,row)["Quantity Ledger"],raw["Quantity Ledger"]);
});
test("multi-links are rejected rather than silently collapsed",()=>{
 const entity=ENTITIES.find(e=>e.name==="requirements")!;
 assert.throws(()=>normalizeRow(entity,{id:1,Part:[{id:1},{id:2}]}),/refusing to collapse/);
});
test("manufacturing configuration fails closed without both Supabase server credentials",()=>{
 assert.throws(()=>manufacturingSupabaseConfig({}),/credentials are missing/);
 assert.throws(()=>manufacturingSupabaseConfig({NEXT_PUBLIC_SUPABASE_URL:"https://example.test"}),/credentials are missing/);
 assert.deepEqual(manufacturingSupabaseConfig({NEXT_PUBLIC_SUPABASE_URL:" https://example.test ",SUPABASE_SECRET_KEY:" secret "}),{url:"https://example.test",serviceKey:"secret"});
 assert.deepEqual(manufacturingSupabaseConfig({NEXT_PUBLIC_SUPABASE_URL:"https://example.test",SUPABASE_SERVICE_ROLE_KEY:"legacy"}),{url:"https://example.test",serviceKey:"legacy"});
});

test("Supabase reader validates the private attachment catalog",async()=>{
 const adapter=createSupabaseManufacturingAdapter({url:"https://example.test",serviceKey:"sb_secret_test",fetch:async(input,init)=>{
  assert.match(String(input),/manufacturing_attachment_manifest$/);
  assert.equal(init?.method,"POST");
  assert.equal(new Headers(init?.headers).get("apikey"),"sb_secret_test");
  assert.equal(new Headers(init?.headers).has("authorization"),false);
  return Response.json([{part_id:3,kind:"drawing-pdf",position:0,original_name:"P-1 REV B.pdf"}]);
 }});
 assert.deepEqual(await adapter.readAttachments(),[{partId:3,kind:"drawing-pdf",position:0,originalName:"P-1 REV B.pdf"}]);
 const invalid=createSupabaseManufacturingAdapter({url:"https://example.test",serviceKey:"test",fetch:async()=>Response.json([{part_id:3,kind:"drawing-pdf",position:-1,original_name:"bad.pdf"}])});
 await assert.rejects(invalid.readAttachments(),/Invalid manufacturing attachment manifest row/);
});
test("Supabase reader accepts only an opaque numeric manufacturing version",async()=>{
 const adapter=createSupabaseManufacturingAdapter({url:"https://example.test",serviceKey:"sb_secret_test",fetch:async(input,init)=>{
  assert.match(String(input),/manufacturing_data_version$/);
  assert.equal(init?.method,"POST");
  assert.equal(init?.cache,"no-store");
  return Response.json("123456");
 }});
 assert.equal(await adapter.readDataVersion(),"123456");
 const invalid=createSupabaseManufacturingAdapter({url:"https://example.test",serviceKey:"test",fetch:async()=>Response.json(123456)});
 await assert.rejects(invalid.readDataVersion(),/Invalid manufacturing data version/);
});
test("parity reports meaningful differences without including private values",()=>{
 const report=compareRows([{id:1,notes:"secret-a"}],[{id:1,notes:"secret-b"}],"id");
 assert.equal(report.clean,false);assert.deepEqual(report.fields,{"1":["notes"]});
 assert.ok(!JSON.stringify(report).includes("secret"));
 assert.throws(()=>compareRows([{id:1},{id:1}],[],"id"),/Duplicate/);
});
test("Supabase reader exhausts pagination and rejects duplicates and source count drift",async()=>{
 let calls=0;
 const adapter=createSupabaseManufacturingAdapter({url:"https://example.test",serviceKey:"test",fetch:async(_input,init)=>{
  assert.equal(init?.method,"GET");calls++;
  return Response.json(calls===1?{total:2,rows:[{id:1}]}:{total:2,rows:[{id:2}]});
 }});
 assert.equal((await adapter.readEntity("operations")).length,2);
 const bad=createSupabaseManufacturingAdapter({url:"https://example.test",serviceKey:"test",fetch:async()=>Response.json({total:2,rows:[{id:1},{id:1}]})});
 await assert.rejects(bad.readEntity("operations"),/Duplicate/);
 let n=0;
 const drift=createSupabaseManufacturingAdapter({url:"https://example.test",serviceKey:"test",fetch:async()=>Response.json(++n===1?{total:2,rows:[{id:1}]}:{total:3,rows:[{id:2}]})});
 await assert.rejects(drift.readEntity("operations"),/changed/);
});

test("snapshot reads include assembly identities and bound entity concurrency", async () => {
 let activeEntityReads=0;let maxEntityReads=0;const requestedEntities:string[]=[];
 const adapter=createSupabaseManufacturingAdapter({url:"https://example.test",serviceKey:"test",fetch:async(input)=>{
  const url=new URL(String(input));
  if(url.pathname.endsWith("manufacturing_attachment_manifest")) return Response.json([]);
  const entity=url.searchParams.get("p_entity");
  assert.ok(entity);requestedEntities.push(entity);activeEntityReads++;maxEntityReads=Math.max(maxEntityReads,activeEntityReads);
  await new Promise(resolve=>setTimeout(resolve,5));activeEntityReads--;
  return Response.json({total:0,rows:[]});
 }});
 assert.deepEqual(await adapter.readSnapshot(),{operations:[],jobs:[]});
 assert.deepEqual(requestedEntities.sort(),["assemblies","finishing","operations","parts","requirements"]);
 assert.equal(maxEntityReads,2);
});

test("timestamp comparison detects microsecond changes",()=>{
 const entity=ENTITIES.find(e=>e.name==="operations")!;const raw={id:1,"Started At":"2026-09-01T00:00:00.123456Z"};const row=normalizeRow(entity,raw) as NormalizedRow;row.started_at="2026-09-01T00:00:00.123789+00:00";assert.equal(denormalizeRow(entity,row)["Started At"],row.started_at);
});

test("synced identities override stale Baserow labels and support records with no source row metadata", async () => {
 const rows: Record<string, object[]> = {
  assemblies: [{id:4,source_row:{},assembly_number:"A-CURRENT"}],
  parts: [{id:3,source_row:{},part_number:"P-CURRENT",name:"Gear Spacer",revision:"C",drawing_url:"https://example.test/current-drawing"}],
  requirements: [
   {id:2,source_row:{Part:[{id:3,value:"P-OLD"}],Assembly:[{id:4,value:"A-OLD"}],Revision:"A"},part_id:3,assembly_id:4,required_quantity:2,required_part_revision:"B",active_in_bom:true},
   {id:5,source_row:{},part_id:3,assembly_id:4,required_quantity:4,required_part_revision:"B",active_in_bom:true},
  ],
  operations: [
   {id:1,source_row:{"Production Requirement":[{id:2,value:"P-OLD — 95T Belt [A-OLD]"}]},requirement_id:2,operation_key:"old|OP1",operation_number:"OP1",machine:"Bambu 3D Printer",status:"In Progress",active_in_routing:true,claimed_quantity:2},
   {id:6,source_row:{},requirement_id:5,operation_key:"new|OP1",operation_number:"OP1",machine:"Haas CNC",status:"Planned",active_in_routing:true},
   {id:7,source_row:{},requirement_id:5,operation_key:"new|OP2",operation_number:"OP2",machine:"Countersinking",status:"Planned",active_in_routing:true},
  ],
  finishing: [{id:8,source_row:{},requirement_id:5,production_key:"new",active:true}],
 };
 const adapter=createSupabaseManufacturingAdapter({url:"https://example.test",serviceKey:"test",fetch:async(input)=>{
  const url=new URL(String(input));
  if(url.pathname.endsWith("manufacturing_attachment_manifest")) return Response.json([]);
  const entity=rows[url.searchParams.get("p_entity")!];
  return Response.json({total:entity.length,rows:entity});
 }});
 const {operations,jobs}=await adapter.readSnapshot();
 assert.equal(operations.length,3);
 for(const operation of operations) {
  assert.equal(operation.partNumber,"P-CURRENT");
  assert.equal(operation.partName,"Gear Spacer");
  assert.equal(operation.assemblyNumber,"A-CURRENT");
  assert.equal(operation.revision,"B");
  assert.equal(operation.drawingUrl,"https://example.test/current-drawing");
 }
 assert.equal(operations[0].status,"In Progress");
 assert.equal(operations[0].claimedQuantity,2);
 assert.deepEqual(operations.filter(o=>o.requirementId===5).map(o=>o.machine),["Haas CNC","Countersinking"]);
 assert.equal(jobs[0].partName,"Gear Spacer");
 assert.equal(jobs[0].partNumber,"P-CURRENT");
 assert.equal(jobs[0].assemblyNumber,"A-CURRENT");
});
