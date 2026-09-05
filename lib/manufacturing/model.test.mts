import test from "node:test";
import assert from "node:assert/strict";
import {ENTITIES,normalizeRow,denormalizeRow,type NormalizedRow} from "./model.ts";
import {manufacturingConfig,assertBaserowWriteSource} from "./config.ts";
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
test("source flags default to Baserow and cannot accidentally enable Supabase writes",()=>{
 assert.deepEqual(manufacturingConfig({}),{read:"baserow",write:"baserow",shadow:false});
 assert.doesNotThrow(()=>assertBaserowWriteSource({}));
 assert.throws(()=>assertBaserowWriteSource({MANUFACTURING_WRITE_SOURCE:"supabase"}),/only available/);
 assert.throws(()=>manufacturingConfig({MANUFACTURING_READ_SOURCE:"typo"}),/Invalid/);
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

test("timestamp comparison detects microsecond changes",()=>{
 const entity=ENTITIES.find(e=>e.name==="operations")!;const raw={id:1,"Started At":"2026-09-01T00:00:00.123456Z"};const row=normalizeRow(entity,raw) as NormalizedRow;row.started_at="2026-09-01T00:00:00.123789+00:00";assert.equal(denormalizeRow(entity,row)["Started At"],row.started_at);
});
